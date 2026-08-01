# HTTP API reference

Base URL: `http://localhost:4000/api`. All request and response bodies are JSON.

Errors share one shape:

```json
{ "error": "CODE", "message": "human readable", "details": [ ... ] }
```

| Status | When |
| ------ | ---- |
| 400 | invalid input (e.g. empty prompt) |
| 401 | missing or invalid session token (`UNAUTHENTICATED`) |
| 403 | not bound to an org (`ORG_REQUIRED`) or insufficient role (`FORBIDDEN`) |
| 404 | unknown project/vault entry — including resources that belong to another org |
| 409 | scaffolding a spec that isn't ready (without `force`) |
| 422 | a submitted workflow failed validation (`details` lists each error) |
| 500 | unexpected server error |

---

## Authentication & tenant isolation

Every endpoint except `GET /health` requires a Clerk session JWT:

```
Authorization: Bearer <session token>
```

The server verifies the token cryptographically, reads the `org_id` claim,
and scopes every query to that organization. A resource that belongs to
another org behaves exactly like a missing resource (404). Roles map from the
`org_role` claim: `org:owner`/`org:admin` = **Owner**,
`org:architect`/`org:editor` = **Architect**, `org:viewer`/`org:member` =
**Viewer**. Writes require Architect+, deletes require Owner.

Local development without Clerk (`AUTH_MODE` unset): identity comes from
headers — `x-org-id`, `x-user-id`, `x-user-role` — with a stable default org.
This mode never runs in production.

## Health

### `GET /health`
```json
{ "status": "ok" }
```

## Projects

### `POST /projects`
Create a project from a prompt.
```json
// request
{ "prompt": "summarise my unread emails into a morning digest" }
// 201 response
{ "id": "…", "prompt": "…", "answers": {}, "spec": { … }, "createdAt": "…", "updatedAt": "…" }
```

### `GET /projects`
List all projects, newest first.

### `GET /projects/:id`
Fetch one project. `404` if unknown.

### `DELETE /projects/:id`
Delete a project (and its workflow, via cascade). `→ { "deleted": true, "id": "…" }`.

## Grill me

### `GET /projects/:id/grill?deep=false`
Return the next clarifying questions and progress.
```json
{
  "projectId": "…",
  "questions": [
    { "id": "goal.outcome", "dimension": "goal", "critical": true, "prompt": "What is the single concrete outcome…?" }
  ],
  "coverage": 0.25,
  "ready": false,
  "missing": ["goal", "inputs", "success"],
  "warnings": ["constraints", "edge_cases"],
  "coverage": { "goal": false, "inputs": false, … }
}
```
Pass `?deep=true` to also surface non-critical questions.

### `POST /projects/:id/answers`
Record answers (they merge with prior answers) and re-derive the spec.
```json
// request
{ "answers": { "goal.outcome": "a daily digest", "inputs.source": "gmail inbox" } }
// 200 response: the updated Project (with a fresh spec snapshot)
```

## Workflow builder

### `POST /projects/:id/workflow/scaffold`
Compile the current spec into a starter workflow.
```json
// request
{ "force": false }         // force=true builds even if the spec isn't ready
// 201 response: the scaffolded Workflow
{ "id": "wf_…", "name": "a daily digest", "nodes": [ … ] }
```
`409 SPEC_NOT_READY` if the spec has open critical questions and `force` is not set.

### `PUT /projects/:id/workflow`
Persist a user-edited workflow after validation.
```json
// request
{ "workflow": { "id": "wf_1", "name": "…", "nodes": [ { "id": "a", "type": "input", "name": "A", "dependsOn": [] } ] } }
// 200 response: the saved Workflow
// 422 response if invalid:
{ "error": "INVALID_WORKFLOW", "message": "Workflow failed validation.",
  "details": [ { "code": "CYCLE", "message": "Workflow contains a cycle involving: a, b, c." } ] }
```

Validation error codes: `EMPTY`, `MISSING_ID`, `DUPLICATE_ID`, `BAD_TYPE`,
`BAD_DEPENDS_ON`, `SELF_DEPENDENCY`, `DANGLING_DEPENDENCY`, `CYCLE`.

### `GET /projects/:id/workflow`
Fetch the saved workflow, or `null` if none has been built yet.

---

## LLM key vault

Envelope-encrypted storage for provider API keys (OpenAI / Anthropic /
Gemini / DeepSeek). A per-organization Data Encryption Key (DEK) encrypts the provider
key; the DEK itself is wrapped by an environment Key Encryption Key (KEK,
`VAULT_KEK`). Read endpoints return **masked labels only** — plaintext keys
and wrapped material never appear in any response.

### `POST /vault` (Architect+)
```json
// request
{ "provider": "openai", "label": "prod", "apiKey": "sk-proj-…" }
// 201 response — masked only
{ "id": "vk_…", "provider": "openai", "label": "prod",
  "keyHandle": "kh_…", "maskedKey": "sk-p…9f2c", "createdAt": "…", "updatedAt": "…" }
```

### `GET /vault` (Architect+) / `GET /vault/{id}` (Architect+)
Masked entries only — same shape as above, never the plaintext or the
wrapped blobs.

### `DELETE /vault/{id}` (Owner)
Deletes an entry; 404 if it does not exist in the caller's org.

The plaintext is only ever recoverable server-side via the internal
`VaultService.revealKey()` used by the workflow executor — no HTTP route
exposes it.

---

## Pre-flight validation (Increment 4)

### `POST /workflow/preflight`
Run the full static gate over a workflow: structural DAG checks (cycles,
dangling refs, duplicate ids), reachability (islands, unreachable nodes,
dead ends), schema parameter matching, tool-boundary constraints against
the marketplace allow-list, and the security boundary reassertion. Pure
static analysis — nothing is executed.

```json
// request
{ "workflow": { "id": "wf_1", "name": "…", "nodes": [ … ] } }
// 200 response — a report, not an error
{
  "valid": true,
  "summary": "ok: 1 warning",
  "errors": [],
  "warnings": [ { "code": "UNBOUND_AGENT", "message": "…", "nodeId": "agent-1" } ],
  "checks": [
    { "name": "structural", "passed": true, "count": 0 },
    { "name": "reachability", "passed": true, "count": 0 },
    { "name": "schema", "passed": true, "count": 0 },
    { "name": "toolBoundary", "passed": true, "count": 0 },
    { "name": "security", "passed": true, "count": 0 }
  ],
  "security": { "executedCode": false, "boundary": "static-only", "blocked": [] }
}
```

Pre-flight error codes: `CYCLE`, `DANGLING_DEPENDENCY`, `DUPLICATE_ID`,
`MISSING_CONFIG`, `CONFIG_TYPE`, `CONFIG_VALUE`, `NON_SERIALIZABLE_CONFIG`,
`MISSING_PERSONA`, `UNKNOWN_TOOL`, `TOOL_NOT_PERMITTED`, `SECURITY_BOUNDARY`.
Warnings: `DISCONNECTED_NODE`, `UNREACHABLE_FROM_INPUT`, `NO_PATH_TO_OUTPUT`,
`UNBOUND_AGENT`, `UNKNOWN_CONFIG_KEY`, `CATALOG_TOOL_DRIFT`.

## GitHub publishing (Increment 4)

### `GET /github/auth-url` (Architect+)
Start the OAuth dance. Returns `{ "url": "https://github.com/login/oauth/authorize?…" }`.
The client opens the URL in a popup; GitHub redirects to `/github/callback`
which stores the sealed token and postMessages the result back.

### `GET /github/status` (Viewer+)
`{ "connected": true, "login": "octo-user", "scopes": ["repo"], "publications": [ … ] }`
— never exposes the token.

### `DELETE /github/connection` (Owner)
Disconnect the org's GitHub account.

### `POST /projects/:id/publish` (Architect+, **Team tier**)
Pre-flight → codegen (typed interfaces + CI + fallback handlers) →
scaffold `spec.yaml`/`workflow.json` → create repo → git-data push (4
requests, <5s SLA) → publication ledger.

```json
// request
{ "repoName": "weekly-newsletter", "description": "", "private": true, "branch": "main" }
// 200 response
{
  "repoUrl": "https://github.com/octo-user/weekly-newsletter",
  "sha": "…", "branch": "main", "latencyMs": 812, "fileCount": 10,
  "summary": "Published 10 files to octo-user/weekly-newsletter in 812ms",
  "publication": { "id": "…", "repoName": "weekly-newsletter", "repoUrl": "…", "fileCount": 10, "latencyMs": 812, "createdAt": "…" }
}
```

`402 PAYMENT_REQUIRED` on the Free tier (Team subscription or trial
required). `422 PREFLIGHT_FAILED` with the error list when the workflow
does not pass the gate.

## Stripe billing & entitlements (Increment 4)

### `GET /billing` (Viewer+)
Subscription state: `{ plan, status, statusLabel, trialEnd, currentPeriodEnd, cancelAtPeriodEnd }`.
Status machine: `none → trialing → active → past_due → canceled` (+
`incomplete` while 3DS is pending). Unknown statuses fail closed to `none`.

### `GET /billing/entitlement` (Viewer+)
The effective tier + quota:
```json
{
  "orgId": "…", "tier": "free", "label": "Free",
  "limits": { "grillSessionsPerMonth": 10, "exports": false, "unlimitedGrill": false, "preview": "mock" },
  "usage": { "grillSessionsThisMonth": 3 },
  "billing": { "plan": "free", "status": "none", "trialEnd": null, "currentPeriodEnd": null }
}
```
Team/trial: `grillSessionsPerMonth: null`, `exports: true`, `preview: "simulated"`.

### `POST /billing/checkout` (Architect+)
```json
// request
{ "successUrl": "https://workflow-builders.com/?billing=success", "cancelUrl": "…", "tierId": "team" }
// 200 response
{ "url": "https://checkout.stripe.com/c/pay/…", "sessionId": "cs_…" }
```
`503 BILLING_NOT_CONFIGURED` when Stripe is not configured.

### `POST /billing/portal` (Architect+)
`{ "url": "https://billing.stripe.com/p/session/…" }` — `409 NO_CUSTOMER`
if the org has no Stripe customer yet.

### `POST /billing/webhook` (public)
Stripe delivers events here. The RAW body is signature-verified against
`stripe-signature` (`400 INVALID_SIGNATURE` on failure), event ids are
deduplicated in the `billing_events` ledger (replays are acked, never
re-applied), and subscription state is re-fetched from Stripe so
out-of-order delivery cannot regress the row.

## Telemetry (Increment 4)

### `POST /telemetry/events` (Viewer+)
```json
// request
{ "event": "lens_selected", "props": { "source": "nuwa-skill" } }
// 200 response
{ "captured": true, "event": "lens_selected" }
```
Properties are filtered through an allowlist server-side (prompt text, API
keys and free-form content are dropped) and the org id is pseudonymized
(truncated sha256) before anything is stored or sent to PostHog.

## Quota & payment error codes

| Code | Status | Meaning |
|------|--------|---------|
| `QUOTA_EXCEEDED` | 402 | Free plan's 10 Grill sessions/month consumed |
| `PAYMENT_REQUIRED` | 402 | Export/unlimited loops need Team or trial |
| `GITHUB_NOT_CONNECTED` | 401 | Connect a GitHub account (repo scope) first |
| `GITHUB_AUTH_REQUIRED` | 401 | Stored token rejected — re-authenticate (request state is preserved) |
| `PREFLIGHT_FAILED` | 422 | Workflow failed the pre-flight gate (`details.errors` lists each) |
| `INVALID_SIGNATURE` | 400 | Stripe webhook signature verification failed |
| `BILLING_NOT_CONFIGURED` | 503 | Stripe not configured on this deployment |
