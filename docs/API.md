# HTTP API reference

Base URL: `http://localhost:4000/api`. All request and response bodies are JSON.

Errors share one shape:

```json
{ "error": "CODE", "message": "human readable", "details": [ ... ] }
```

| Status | When |
| ------ | ---- |
| 400 | invalid input (e.g. empty prompt) |
| 404 | unknown project |
| 409 | scaffolding a spec that isn't ready (without `force`) |
| 422 | a submitted workflow failed validation (`details` lists each error) |
| 500 | unexpected server error |

---

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
