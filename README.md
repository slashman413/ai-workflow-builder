# AI Workflow Builder

Turn a one-line prompt into a validated agent workflow.

Most "AI workflow" tools drop you onto a blank canvas and assume you already
know exactly what you want. This project inverts that: you type a rough goal,
the app **grills you** with the clarifying questions a good engineer would ask,
and only once the spec is solid does it scaffold an agent workflow you can edit.

```
   ┌────────┐    ┌────────────┐    ┌──────────────────┐
   │ Prompt │ →  │  Grill me  │ →  │  Agent workflow  │
   └────────┘    └────────────┘    └──────────────────┘
   one line     clarifying Q&A     validated DAG of steps
                → structured spec
```

- **Frontend:** React 18 + Vite
- **Backend:** Node.js (Express) — ESM, no transpiler
- **Database:** SQLite (via the built-in `node:sqlite`, zero native build)
- **License:** MIT

---

## The three core features

1. **Simple prompt input** — one text box. `POST /api/projects`.
2. **"Grill me" for a spec** — a deterministic question engine interrogates the
   prompt across six spec dimensions (goal, inputs, outputs, constraints,
   success criteria, edge cases) and reports coverage until the spec is *ready*.
   `GET /api/projects/:id/grill`, `POST /api/projects/:id/answers`.
3. **Agent workflow builder** — compiles the ready spec into a starter DAG of
   agent steps, then validates any edits (unique ids, no dangling deps, no
   cycles). `POST /api/projects/:id/workflow/scaffold`, `PUT …/workflow`.

## Why it's built this way

The valuable, novel logic (the grill engine, spec builder, DAG validation) lives
in a **dependency-free domain layer** that can be unit-tested in milliseconds and
reused on the client. Express, SQLite, and React are *adapters* around that core
(hexagonal architecture). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
the [ADRs](docs/adr/) for the reasoning and the trade-offs.

---

## Quick start

Requires **Node.js ≥ 22.5** (for the built-in `node:sqlite` and the test runner).

```bash
git clone https://github.com/slashman413/ai-workflow-builder.git
cd ai-workflow-builder
npm install          # installs both workspaces (server + web)

# run the tests (domain, services, sqlite, and http integration)
npm test

# start the backend API on :4000 and the Vite dev server on :5173
npm run dev
```

Then open http://localhost:5173. The Vite dev server proxies `/api` to the
backend, so there is no CORS to configure.

### Run the pieces separately

```bash
npm run dev:server     # API only, http://localhost:4000
npm run dev:web        # UI only, http://localhost:5173
npm run build          # production build of the web app -> web/dist
npm start              # run the API against a persistent SQLite file
```

Environment variables (backend):

| Var          | Default          | Meaning                                   |
| ------------ | ---------------- | ----------------------------------------- |
| `PORT`       | `4000`           | API port                                  |
| `DB_FILE`    | `./data/app.db`  | SQLite file path                          |
| `USE_MEMORY` | *(unset)*        | Set to `1` for a non-persistent in-memory store |

---

## Try the API by hand

```bash
# 1. create a project from a prompt
curl -s localhost:4000/api/projects -H 'content-type: application/json' \
  -d '{"prompt":"summarise my unread emails into a morning digest"}'

# 2. see what it wants to grill you about
curl -s localhost:4000/api/projects/<ID>/grill

# 3. answer some questions
curl -s localhost:4000/api/projects/<ID>/answers -H 'content-type: application/json' \
  -d '{"answers":{"goal.outcome":"a daily digest","inputs.source":"gmail inbox","outputs.shape":"markdown","success.measure":"no urgent email missed"}}'

# 4. scaffold the workflow
curl -s -X POST localhost:4000/api/projects/<ID>/workflow/scaffold \
  -H 'content-type: application/json' -d '{}'
```

Full endpoint reference: [`docs/API.md`](docs/API.md).

---

## Project layout

```
ai-workflow-builder/
├── server/                 # Node.js backend (workspace)
│   ├── src/
│   │   ├── domain/         # pure logic, ZERO dependencies
│   │   │   ├── grill/      # the "grill me" engine + question bank
│   │   │   ├── spec/       # prompt+answers -> structured Spec -> node suggestions
│   │   │   └── workflow/   # DAG model, topo-sort, invariant validation
│   │   ├── application/    # use-case services + outbound ports
│   │   ├── adapters/       # http (Express) + persistence (sqlite / in-memory)
│   │   └── index.js        # composition root (wires adapters together)
│   └── test/               # node:test suite (no external test framework)
├── web/                    # React + Vite frontend (workspace)
│   └── src/                # PromptInput → GrillPanel → WorkflowView
├── docs/                   # ARCHITECTURE, DOMAIN, API, and ADRs
└── .github/workflows/ci.yml
```

## Testing

Tests use the **built-in Node test runner** (`node --test`) and `node:assert` —
no Jest/Mocha to install, so the domain suite runs on a bare checkout.

- `test/grillEngine.test.js` — grill logic & readiness
- `test/workflow.test.js` — validation, cycle detection, topo-sort
- `test/projectService.test.js` — the end-to-end use-case flow (in-memory repo)
- `test/sqliteRepos.test.js` — persistence round-trip (skips if `node:sqlite` absent)
- `test/http.test.js` — REST integration (skips until `express` is installed)

```bash
npm test
```

## Roadmap (not yet built)

This repo is a well-tested **foundation**, deliberately scoped. Clear next steps,
each isolated by the existing boundaries:

- **Workflow executor** — run a validated DAG in topo order against real agents.
  The `topoSort` order and node `config` contracts are already in place.
- **LLM-assisted grilling** — an adapter behind the grill engine that proposes
  richer, context-specific questions while keeping the deterministic floor
  (see [ADR-0004](docs/adr/0004-deterministic-grill-engine.md)).
- **Drag-to-edit canvas** — the backend already validates arbitrary edited
  graphs via `PUT /workflow`; the UI currently renders a read-first view.
- **Auth & multi-user** — projects are currently unscoped.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) to get involved.
