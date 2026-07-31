# API Reference

The `ai-workflow-builder` service exposes a small REST API (FastAPI) for turning a prompt into a tested, publishable multi-agent workflow. This page documents every endpoint, its request and response shapes, and its error codes.

- **Base URL (local):** `http://localhost:8000`
- **API version prefix:** `/api/v1`
- **Content type:** `application/json` for all request and response bodies
- **Interactive docs:** the running service serves Swagger UI at `/docs` and ReDoc at `/redoc`

> The lifecycle of every build is: **submit prompt → answer Grill-Me questions until the spec resolves → generate → test → (optionally) publish.** The state machine that drives this is described under [Workflow states](#workflow-states).

## Authentication

All `/api/v1/*` endpoints require an API key sent as a bearer token:

```
Authorization: Bearer <API_KEY>
```

The server reads the accepted key(s) from the `AWB_API_KEYS` environment variable (comma-separated). Requests without a valid key receive `401 Unauthorized`. The `GET /health` endpoint is unauthenticated.

Model-provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) and the `GITHUB_TOKEN` are configured **server-side** and are never sent in API requests. See the [Deployment Guide](deployment-guide.md#environment-variables).

## Rate limiting

The service limits requests per API key. When exceeded, it returns `429 Too Many Requests` with a `Retry-After` header (seconds). Defaults are configurable via `AWB_RATE_LIMIT_PER_MINUTE` (default `60`).

## Conventions

- Timestamps are RFC 3339 / ISO 8601 in UTC (e.g. `2026-07-31T09:20:00Z`).
- IDs are opaque strings; do not parse them. Workflow IDs are prefixed `wf_`.
- Every error response uses the shape documented under [Errors](#errors).
- `curl` examples assume `export AWB=http://localhost:8000` and `export KEY=<API_KEY>`.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness/readiness probe (unauthenticated). |
| `GET` | `/api/v1/agents` | List agents available in the Agent Registry. |
| `POST` | `/api/v1/workflows` | Submit a prompt and start a build. |
| `GET` | `/api/v1/workflows` | List your workflows (paginated). |
| `GET` | `/api/v1/workflows/{id}` | Get a workflow's current state. |
| `GET` | `/api/v1/workflows/{id}/questions` | Get open Grill-Me questions. |
| `POST` | `/api/v1/workflows/{id}/answers` | Answer Grill-Me questions to advance the spec. |
| `GET` | `/api/v1/workflows/{id}/spec` | Get the resolved, versioned spec. |
| `GET` | `/api/v1/workflows/{id}/artifacts` | List generated code artifacts. |
| `GET` | `/api/v1/workflows/{id}/test-report` | Get the Reliability Engine test report. |
| `POST` | `/api/v1/workflows/{id}/publish` | Push the generated workflow to a GitHub repo. |
| `DELETE` | `/api/v1/workflows/{id}` | Delete a workflow and its artifacts. |

---

### `GET /health`

Liveness and readiness probe. Unauthenticated. Returns `200` when the process is up and its dependencies (database, at least one model provider) are reachable; `503` otherwise.

```bash
curl $AWB/health
```

```json
{ "status": "ok", "version": "1.0.0", "checks": { "database": "ok", "model_provider": "ok" } }
```

---

### `GET /api/v1/agents`

Lists the agents registered in the **Agent Registry** — the capability catalog the generator draws from when assembling a workflow.

**Query parameters**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `capability` | `string` | – | Filter to agents that provide this capability (e.g. `summarize`, `translate`, `web.fetch`). |

```bash
curl -H "Authorization: Bearer $KEY" "$AWB/api/v1/agents?capability=translate"
```

```json
{
  "agents": [
    {
      "id": "translator",
      "name": "Translator Agent",
      "capabilities": ["translate"],
      "inputs": ["text", "target_language"],
      "outputs": ["text"],
      "provider": "model"
    }
  ]
}
```

---

### `POST /api/v1/workflows`

Submit a prompt and start a build. Returns `201` with the new workflow. The workflow starts in state `ingesting`; poll `GET /api/v1/workflows/{id}` (or read the `state` in the response) to follow it.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | **yes** | The natural-language description of the workflow to build. 1–4000 chars. |
| `interactive` | `boolean` | no (default `true`) | If `true`, the build pauses on `needs_clarification` and waits for answers. If `false`, the builder makes documented best-effort assumptions and records them in the spec instead of asking. |
| `auto_publish` | `boolean` | no (default `false`) | If `true`, publish automatically once tests pass. Requires a server-side `GITHUB_TOKEN`. |
| `repo` | `object` | no | Publish target. `{ "name": "my-workflow", "private": true }`. Defaults to a generated name. |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"Summarize a URL, translate it to Traditional Chinese, and post to Slack","interactive":true}' \
  $AWB/api/v1/workflows
```

```json
{
  "id": "wf_9f2a7c1b",
  "state": "needs_clarification",
  "prompt": "Summarize a URL, translate it to Traditional Chinese, and post to Slack",
  "open_questions": 2,
  "created_at": "2026-07-31T09:20:00Z"
}
```

**Errors:** `400` (`VALIDATION_ERROR` — missing/oversized `prompt`), `401`, `429`.

---

### `GET /api/v1/workflows`

Lists your workflows, newest first.

**Query parameters:** `state` (filter), `limit` (default `20`, max `100`), `cursor` (opaque pagination token).

```json
{
  "workflows": [
    { "id": "wf_9f2a7c1b", "state": "needs_clarification", "created_at": "2026-07-31T09:20:00Z" }
  ],
  "next_cursor": null
}
```

---

### `GET /api/v1/workflows/{id}`

Returns the full current state of a workflow, including counts you can use to decide what to do next.

```bash
curl -H "Authorization: Bearer $KEY" $AWB/api/v1/workflows/wf_9f2a7c1b
```

```json
{
  "id": "wf_9f2a7c1b",
  "state": "generating",
  "prompt": "Summarize a URL, translate it to Traditional Chinese, and post to Slack",
  "spec_version": 3,
  "open_questions": 0,
  "test_report": null,
  "repo_url": null,
  "created_at": "2026-07-31T09:20:00Z",
  "updated_at": "2026-07-31T09:22:14Z"
}
```

**Errors:** `404` (`NOT_FOUND`), `401`.

---

### `GET /api/v1/workflows/{id}/questions`

Returns the open Grill-Me questions when the workflow is in `needs_clarification`. Returns an empty list otherwise.

```json
{
  "spec_version": 1,
  "questions": [
    {
      "id": "q_agents",
      "text": "Which target language variant should the translator use?",
      "field": "steps.translate.target_language",
      "kind": "single_choice",
      "options": ["zh-Hant (Traditional)", "zh-Hans (Simplified)"],
      "required": true
    },
    {
      "id": "q_slack_channel",
      "text": "Which Slack channel should the result be posted to?",
      "field": "steps.publish.channel",
      "kind": "free_text",
      "required": true
    }
  ]
}
```

`kind` is one of `free_text`, `single_choice`, `multi_choice`, `boolean`, `number`.

---

### `POST /api/v1/workflows/{id}/answers`

Submit answers to the open questions. Each answer references a question `id`. The server re-runs the spec loop: it may resolve the spec (advancing to `generating`) or surface follow-up questions (a new `spec_version`, still `needs_clarification`).

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `answers` | `array` | **yes** | List of `{ "question_id": string, "value": string \| number \| boolean \| string[] }`. |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"answers":[
        {"question_id":"q_agents","value":"zh-Hant (Traditional)"},
        {"question_id":"q_slack_channel","value":"#daily-digest"}
      ]}' \
  $AWB/api/v1/workflows/wf_9f2a7c1b/answers
```

```json
{ "id": "wf_9f2a7c1b", "state": "generating", "spec_version": 2, "open_questions": 0 }
```

**Errors:** `400` (`VALIDATION_ERROR` — answer references an unknown or already-answered question, or the value fails the question's constraint), `404`, `409` (`INVALID_STATE` — workflow is not in `needs_clarification`).

---

### `GET /api/v1/workflows/{id}/spec`

Returns the resolved, versioned spec — the machine-readable plan the generator builds from. Available once at least one spec version exists.

```json
{
  "spec_version": 2,
  "name": "url-summary-translate-slack",
  "steps": [
    { "id": "fetch",     "agent": "web_fetcher", "inputs": { "url": "{{ input.url }}" } },
    { "id": "summarize", "agent": "summarizer",  "inputs": { "text": "{{ fetch.text }}" } },
    { "id": "translate", "agent": "translator",  "inputs": { "text": "{{ summarize.text }}", "target_language": "zh-Hant" } },
    { "id": "publish",   "agent": "slack_poster","inputs": { "text": "{{ translate.text }}", "channel": "#daily-digest" } }
  ],
  "assumptions": [],
  "budgets": { "max_latency_ms": 30000, "max_cost_usd": 0.05 }
}
```

When a workflow was built with `interactive: false`, any best-effort decisions appear in `assumptions[]` so they are auditable.

---

### `GET /api/v1/workflows/{id}/artifacts`

Lists the generated code artifacts. Fetch an individual file's content by appending its `path` as a query on `/artifacts/content`, or download the whole set as a zip.

```json
{
  "artifacts": [
    { "path": "workflow.py",        "bytes": 4213, "sha256": "b1946ac9…" },
    { "path": "tests/test_workflow.py", "bytes": 2871, "sha256": "3c1bd8a2…" },
    { "path": "pyproject.toml",      "bytes": 612,  "sha256": "9d2f0e6b…" },
    { "path": "README.md",           "bytes": 1044, "sha256": "77 a3f0…" }
  ],
  "download_url": "/api/v1/workflows/wf_9f2a7c1b/artifacts/archive"
}
```

Artifacts exist only after the workflow reaches `generated` (or later). Requesting them earlier returns `409 INVALID_STATE`.

---

### `GET /api/v1/workflows/{id}/test-report`

Returns the Reliability Engine's report for the generated workflow: unit, integration, and fuzz results plus static analysis. `passed` gates publishing.

```json
{
  "passed": true,
  "suites": {
    "unit":        { "passed": 18, "failed": 0, "skipped": 0 },
    "integration": { "passed": 5,  "failed": 0, "skipped": 0 },
    "fuzz":        { "cases": 500, "failures": 0 }
  },
  "static_analysis": { "ruff": "clean", "mypy": "clean", "black": "formatted" },
  "coverage_percent": 100,
  "duration_seconds": 41.7
}
```

If `passed` is `false`, `suites` includes the failing case details and the workflow remains in `test_failed`; it is not eligible for publishing.

---

### `POST /api/v1/workflows/{id}/publish`

Creates a GitHub repository (or pushes to an existing one) and commits the generated artifacts. Requires a server-side `GITHUB_TOKEN` and a workflow whose latest test report `passed`.

**Request body** (all optional; overrides the values from `POST /workflows`)

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Repository name. Defaults to the spec `name`. |
| `private` | `boolean` | Create as private (default `true`). |
| `description` | `string` | Repository description. |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"url-digest-bot","private":false}' \
  $AWB/api/v1/workflows/wf_9f2a7c1b/publish
```

```json
{
  "id": "wf_9f2a7c1b",
  "state": "published",
  "repo_url": "https://github.com/slashman413/url-digest-bot",
  "commit_sha": "e83c5163316f89bfbde7d9ab23ca2e25604af290"
}
```

**Errors:** `409` (`INVALID_STATE` — tests did not pass, or nothing to publish), `422` (`PUBLISH_TOKEN_MISSING` — no `GITHUB_TOKEN` configured), `502` (`UPSTREAM_ERROR` — GitHub API failure; safe to retry).

---

### `DELETE /api/v1/workflows/{id}`

Deletes the workflow record and its stored artifacts. Does **not** delete an already-published GitHub repository. Returns `204 No Content`.

---

## Workflow states

A workflow moves through a deterministic state machine:

```
ingesting ──▶ needs_clarification ──▶ generating ──▶ generated ──▶ testing ──┬──▶ tested ──▶ publishing ──▶ published
                     ▲   │                                                   │
                     └───┘ (follow-up questions)                             └──▶ test_failed
any state ──▶ error (unrecoverable; see error field)
```

| State | Meaning | What to do |
|-------|---------|------------|
| `ingesting` | Prompt is being parsed and classified. | Poll. |
| `needs_clarification` | Grill-Me has open questions. | `GET …/questions`, then `POST …/answers`. |
| `generating` | Spec resolved; code is being generated. | Poll. |
| `generated` | Artifacts exist; tests not yet run. | Poll (testing starts automatically). |
| `testing` | Reliability Engine is running. | Poll. |
| `tested` | Tests passed. | `POST …/publish` (or done if `auto_publish`). |
| `test_failed` | Tests failed. | Inspect `GET …/test-report`; refine the prompt/spec in a new workflow. |
| `publishing` | Pushing to GitHub. | Poll. |
| `published` | Repo created and pushed. | Read `repo_url`. |
| `error` | Unrecoverable failure. | Read the `error` object; retry from a new workflow. |

---

## Errors

Every error response has HTTP status in the `4xx`/`5xx` range and this body:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "prompt is required and must be 1–4000 characters",
    "field": "prompt"
  }
}
```

| HTTP | `error.code` | When |
|------|--------------|------|
| `400` | `VALIDATION_ERROR` | Malformed body or a value fails a constraint. `field` names the offender. |
| `401` | `UNAUTHORIZED` | Missing or invalid API key. |
| `404` | `NOT_FOUND` | No workflow (or question) with that id for this key. |
| `409` | `INVALID_STATE` | The operation isn't valid in the workflow's current state. |
| `422` | `PUBLISH_TOKEN_MISSING` | Publish requested but no `GITHUB_TOKEN` is configured. |
| `429` | `RATE_LIMITED` | Too many requests; honor `Retry-After`. |
| `500` | `INTERNAL_ERROR` | Unexpected server fault. Safe to retry with backoff. |
| `502` | `UPSTREAM_ERROR` | A model provider or GitHub call failed. Safe to retry. |

**Idempotency.** `POST /api/v1/workflows` and `/publish` accept an optional `Idempotency-Key` header. Re-sending the same key returns the original result instead of creating a duplicate — use it to make retries safe.
