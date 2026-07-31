# Architecture

## 1. Context (C4 level 1)

```
        ┌──────────────┐        HTTPS/JSON        ┌───────────────────────┐
        │   Browser    │ ───────────────────────► │  ai-workflow-builder  │
        │ (React SPA)  │ ◄─────────────────────── │      API (Node.js)    │
        └──────────────┘                          └───────────┬───────────┘
                                                              │  SQL
                                                     ┌────────▼────────┐
                                                     │   SQLite file   │
                                                     └─────────────────┘
```

A single user drafts a prompt, is grilled into a spec, and gets a workflow. No
external services are required to run the core product.

## 2. Containers (C4 level 2)

| Container | Tech | Responsibility |
| --------- | ---- | -------------- |
| `web`     | React 18 + Vite | Three-stage UI: prompt → grill → workflow view |
| `server`  | Node.js + Express | REST API, business logic, persistence |
| database  | SQLite (`node:sqlite`) | Durable storage of projects & workflows |

## 3. The backend is a hexagon (C4 level 3)

The backend follows **ports & adapters / hexagonal architecture**. Dependencies
point *inward*: the domain knows nothing about HTTP, Express, or SQLite.

```
                         ┌──────────────────────────────────────────┐
   HTTP (Express) ─────► │  adapters/http        (inbound adapter)  │
                         │        │                                 │
                         │        ▼                                 │
                         │  application/         (use-case services)│
                         │   ProjectService  ──uses ports──►        │
                         │        │                        ┌────────┴─────────┐
                         │        ▼                        │ adapters/        │
                         │  domain/              (pure)    │  persistence     │──► SQLite
                         │   grill · spec · workflow       │  (outbound       │──► memory
                         │                                 │   adapter)       │
                         └─────────────────────────────────┴──────────────────┘
```

### Layer responsibilities

- **`domain/`** — pure business logic with **zero dependencies**. The grill
  engine, spec builder, DAG model, topological sort, and workflow validation.
  Fully unit-tested; importable from the browser if we ever want client-side
  grilling.
- **`application/`** — use-case services (`ProjectService`) that orchestrate the
  domain and talk to repositories through **ports** (`application/ports.js`).
  This is the only layer that spans grill + spec + workflow. It owns `AppError`,
  which carries an HTTP status but no Express reference.
- **`adapters/http/`** — translates requests to service calls and `AppError`s to
  status codes. No business logic. Controllers never touch repositories directly.
- **`adapters/persistence/`** — two interchangeable implementations of the
  repository ports: `sqliteRepos` (production) and `memoryRepos` (tests/demo).
- **`index.js`** — the **composition root**: the single place that chooses which
  adapters to wire together.

### Dependency rule (enforced by convention + review)

> `domain/` imports nothing outside `domain/`.
> `application/` imports `domain/` only.
> `adapters/` may import `application/` and `domain/`.
> Only `index.js` imports concrete adapters.

Because the domain has no imports of Express/SQLite, the rule is easy to spot-check:
`grep -rE "express|node:sqlite" server/src/domain` must return nothing.

## 4. Key flows

### Grill loop
```
POST /projects            → ProjectService.createProject → buildSpec(prompt, {})     → repo.create
GET  /projects/:id/grill  → nextQuestions(prompt, answers) + assessReadiness
POST /projects/:id/answers→ merge answers → buildSpec(...) → repo.update
                            (repeat grill until readiness.ready === true)
```

### Build
```
POST /projects/:id/workflow/scaffold
  → buildSpec → (ready? else 409 unless force) → suggestNodes → validate → repo.save
PUT  /projects/:id/workflow
  → validateWorkflow (unique ids, resolvable deps, acyclic) → 422 on failure → repo.save
```

## 5. Quality attributes

- **Testability** — the risky logic is pure and dependency-free; the full domain
  suite runs with `node --test` on a bare checkout (no install).
- **Maintainability** — small modules, one responsibility each; the dependency
  direction is greppable.
- **Reliability** — every workflow is validated (cycles, dangling refs) before
  it is persisted or considered runnable; validation collects *all* errors, not
  just the first.
- **Portability** — swapping SQLite for Postgres is a new adapter implementing
  the same port; nothing in `domain/` or `application/` changes.
- **Low operational cost** — SQLite means no database server to run; the whole
  stack is `npm install && npm run dev`.

## 6. Explicitly out of scope (v0.1)

Workflow execution, authentication, multi-tenancy, and a drag-and-drop canvas.
Each has a clear seam already prepared (see the README roadmap). The point of
v0.1 is a correct, well-tested spine — not a feature-complete product.
