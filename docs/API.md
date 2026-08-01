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
