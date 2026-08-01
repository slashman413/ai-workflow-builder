# API Reference

The `ai-workflow-builder` server exposes a small REST API (Node 22 + **Express 4**) for turning a
prompt into a validated multi-agent workflow. This page documents every endpoint, its request and
response shapes, and its error codes.

The machine-readable source of truth is [`openapi.yaml`](../openapi.yaml) in the repo root — import
it into Postman, Stoplight, or a codegen tool. An automated
[contract test](../server/test/contract.test.js) fails CI if this API and that spec ever drift.

- **Base URL (local):** `http://localhost:4000`
- **Base URL (production):** `https://api.workflow-builders.com`
- **Path prefix:** every endpoint is mounted under `/api`
- **Content type:** `application/json` for all request and response bodies
- **Auth:** none in the current increment — the API is unauthenticated. (User management and
  auth arrive in a later increment; see the architecture plan.)

> The lifecycle of every project is: **create from prompt → grill (answer questions) until the
> spec is ready → scaffold a workflow → edit & save (validated).**

## Conventions

- Timestamps are ISO 8601 in UTC (e.g. `2026-08-01T09:20:00Z`).
- Project IDs are opaque UUID strings; workflow IDs are prefixed `wf_`. Do not parse them.
- Every error response uses the [uniform envelope](#errors).
- `curl` examples assume `export API=http://localhost:4000/api`.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness probe (status, service, version, uptime). |
| `POST` | `/api/projects` | Create a project from a prompt. |
| `GET` | `/api/projects` | List all projects. |
| `GET` | `/api/projects/{id}` | Fetch one project (prompt, answers, spec). |
| `DELETE` | `/api/projects/{id}` | Delete a project. |
| `GET` | `/api/projects/{id}/grill` | Get the next Grill-Me questions + readiness. |
| `POST` | `/api/projects/{id}/answers` | Submit answers; re-derives the spec. |
| `POST` | `/api/projects/{id}/workflow/scaffold` | Scaffold a workflow DAG from the spec. |
| `GET` | `/api/projects/{id}/workflow` | Fetch the current workflow. |
| `PUT` | `/api/projects/{id}/workflow` | Save/replace the workflow (validated). |

### `GET /api/health`

Unauthenticated liveness probe used by the container orchestrator and edge.

```bash
curl $API/health
```

```json
{ "status": "ok", "service": "@ai-workflow-builder/server", "version": "0.1.0", "uptime": 42, "timestamp": "2026-08-01T09:20:00Z" }
```

### `POST /api/projects`

Create a project from a one-line prompt. Returns `201` with the new project (a first spec snapshot
is derived immediately).

```bash
curl -X POST $API/projects -H 'content-type: application/json' \
  -d '{ "prompt": "Summarise my emails into a daily digest" }'
```

Errors: `400 INVALID_PROMPT` if the prompt is missing or blank.

### `GET /api/projects` · `GET /api/projects/{id}` · `DELETE /api/projects/{id}`

List returns an array of [Project](#project) objects. Get returns one; `DELETE` returns
`{ "deleted": true, "id": "…" }`. Unknown id → `404 NOT_FOUND`.

### `GET /api/projects/{id}/grill`

Return the open Grill-Me questions and the readiness breakdown for the project. Pass `?deep=true`
to include non-critical questions.

```bash
curl "$API/projects/$ID/grill"
```

Response is a [GrillResult](#grillresult): `questions`, `ready`, `missing`, `warnings`,
`coverage` (a `dimensionId → covered?` map).

### `POST /api/projects/{id}/answers`

Submit a map of `questionId → answer`. The answers are merged and the spec is re-derived.

```bash
curl -X POST $API/projects/$ID/answers -H 'content-type: application/json' \
  -d '{ "answers": { "goal.outcome": "a digest", "inputs.source": "inbox", "outputs.shape": "markdown", "success.measure": "nothing urgent missed" } }'
```

Returns the updated [Project](#project). Errors: `400 INVALID_ANSWERS` if the body is not an object.

### `POST /api/projects/{id}/workflow/scaffold`

Compile the current spec into a starter workflow DAG. Refuses with `409 SPEC_NOT_READY` if the spec
still has open critical questions — pass `{ "force": true }` to override. Returns `201` with the
[Workflow](#workflow).

### `GET` / `PUT /api/projects/{id}/workflow`

`GET` returns the stored workflow (or `null` if none scaffolded yet). `PUT` validates and persists a
user-edited workflow:

```bash
curl -X PUT $API/projects/$ID/workflow -H 'content-type: application/json' \
  -d '{ "workflow": { "id": "wf_1", "name": "digest", "nodes": [ … ] } }'
```

Validation enforces the DAG invariants (unique node ids, known node `type`, no dangling or self
dependencies, acyclic). On failure → `422 INVALID_WORKFLOW` with `details` listing every violation.

---

## Schemas

### Project

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (uuid) | |
| `prompt` | string | |
| `answers` | object | `questionId → answer` gathered so far |
| `spec` | [Spec](#spec) \| null | re-derived from (prompt, answers) |
| `createdAt` / `updatedAt` | string (date-time) | |

### Spec

`goal`, `why`, `inputs[]`, `outputs[]`, `constraints[]`, `successCriteria[]`, `edgeCases[]`,
`ready` (bool — every critical dimension covered), `openQuestions[]`.

### GrillResult

`projectId`, `questions[]` ([Question](#schemas): `id`, `dimension`, `prompt`, `critical`),
`ready`, `missing[]` (uncovered critical dimension ids), `warnings[]` (uncovered non-critical),
`coverage` (`dimensionId → boolean`).

### Workflow

`id`, `name`, `nodes[]`. Each **WorkflowNode**: `id`, `type` (`input` | `agent` | `tool` |
`branch` | `output`), `name`, `config` (node-type-specific), `dependsOn[]` (must resolve; graph
must be acyclic).

---

## Errors

Every error uses one envelope:

```json
{ "error": "INVALID_WORKFLOW", "message": "Workflow failed validation.", "details": [ … ] }
```

| Code | HTTP | When |
|------|------|------|
| `INVALID_PROMPT` | 400 | Prompt missing/blank on create. |
| `INVALID_ANSWERS` | 400 | Answers body is not an object. |
| `NOT_FOUND` | 404 | Unknown project (or unknown endpoint under `/api`). |
| `SPEC_NOT_READY` | 409 | Scaffold attempted before the spec is ready (use `force`). |
| `INVALID_WORKFLOW` | 422 | Saved workflow violates a DAG invariant; see `details`. |
| `INTERNAL` | 500 | Unexpected server error (details are not leaked). |
