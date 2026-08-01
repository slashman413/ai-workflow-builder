# Usage Guide

This guide takes you from a fresh clone to a scaffolded, validated multi-agent workflow. You'll use
the web studio for the fast path, then see the equivalent HTTP calls so you can automate the flow.

**What you'll do**
- Run the app locally (API + web)
- Create a project from a one-line prompt
- Answer the Grill-Me questions that resolve ambiguity
- Scaffold and inspect the workflow DAG

**Prerequisites**
- [ ] **Node.js 22.5 or newer** (`node --version`). Persistence uses the built-in `node:sqlite`
      module, which does not exist on older Node.
- [ ] `git`

Authentication defaults to **dev/test mode**: locally the API accepts any request and binds it to
the `dev-org` workspace (see the auth note under the HTTP examples). Sign-in with Clerk
(GitHub/Google OAuth + organizations) is opt-in and only enforced in production
(`CLERK_SECRET_KEY` set) — you do not need Clerk credentials to run the studio locally.

---

## Step 1: Install

```bash
git clone https://github.com/slashman413/ai-workflow-builder.git
cd ai-workflow-builder
npm install          # installs the server and web workspaces
```

## Step 2: Run it

```bash
npm run dev          # starts the API (:4000) and the Vite dev server (:5173)
```

Open **http://localhost:5173**. The Vite dev server proxies `/api` to the backend, so there is no
CORS to configure. To run only one side: `npm run dev:server` or `npm run dev:web`.

## Step 3: Build a workflow in the studio

1. **Enter a prompt**, e.g. *"Summarise my emails into a daily digest and flag anything urgent."*
2. The **Grill-Me panel** shows the questions the spec still needs — goal, inputs, output shape,
   success measure. Answer them; the readiness meter fills as critical dimensions get covered.
3. When the spec is **ready**, scaffold the **workflow**. You get a DAG of typed nodes
   (`input → agent → … → output`) with dependencies.
4. Edit nodes and save. Every save is validated: unique ids, known node types, no dangling or
   self dependencies, and no cycles. Invalid graphs are rejected with the exact violations.

## The same flow over HTTP

Everything the studio does is the REST API. With `export API=http://localhost:4000/api`:

> **Auth in dev/test mode:** requests are bound to the `dev-org` workspace with Owner role by
> default. To act as another user or a more restricted role, send the dev headers the server
> reads in test mode: `x-org-id`, `x-user-role` (`viewer` | `architect` | `owner`), and
> `x-user-id`. In production every request instead carries
> `Authorization: Bearer <Clerk session JWT>` and the org is taken from the token — never from
> the request.

```bash
# 1. Create a project from a prompt
ID=$(curl -s -X POST $API/projects -H 'content-type: application/json' \
      -d '{"prompt":"Summarise my emails into a daily digest"}' | jq -r .id)

# 2. See what the spec still needs
curl -s "$API/projects/$ID/grill" | jq

# 3. Answer the open questions
curl -s -X POST $API/projects/$ID/answers -H 'content-type: application/json' \
  -d '{"answers":{"goal.outcome":"a digest","inputs.source":"inbox","outputs.shape":"markdown","success.measure":"nothing urgent missed"}}' | jq

# 4. Scaffold the workflow DAG
curl -s -X POST $API/projects/$ID/workflow/scaffold -H 'content-type: application/json' -d '{}' | jq
```

See the [API Reference](api-reference.md) for every endpoint, and [`openapi.yaml`](../openapi.yaml)
for the machine-readable contract.

## Beyond the core loop

The same project/workflow surface powers the product's higher-level features — all over HTTP:

- **Realtime Grill-Me (SSE):** `POST /api/grill/stream` streams one question at a time
  (`session | progress | question | ready | compiled | limit` events, ≤ 5 turns / 15k tokens),
  with answers posted to `POST /api/grill/stream/{sessionId}/answers`.
- **Agent Marketplace & Cognitive Lenses:** `GET /api/catalog/*` serves the pinned
  `agency-agents` personas and `nuwa-skill` lenses (divisions, tool tags, fidelity scorecards).
- **Safe preview:** `POST /api/workflow/simulate` runs a mock-handler topological simulation —
  static validation only, nothing executes on the server.
- **Publish gate:** `POST /api/workflow/preflight` runs the full static AST check before export.
- **GitHub publishing:** `GET /api/github/auth-url` starts the OAuth dance; then
  `POST /api/projects/{id}/publish` scaffolds a repo from the generated code and pushes it.
- **LLM key vault:** `POST /api/vault` stores provider keys envelope-encrypted per workspace;
  reads return masked labels only.
- **Billing:** `GET /api/billing/entitlement` shows the current plan and usage
  (Free: 10 Grill sessions/month, mock previews, no export; Team: unlimited).

## Persistence

By default the API stores projects and workflows in SQLite at `server/data/app.db` (auto-created,
git-ignored). To run without persistence for a throwaway session, start the server with
`USE_MEMORY=1`. The schema is managed by versioned migrations in `server/migrations/`, applied
automatically at boot.
