# Contributing to ai-workflow-builder

Thanks for helping build a reliable prompt-to-workflow tool. The bar for changes is high:
**every change ships with tests and passes CI, and code without docs is incomplete.** This guide
gets you from a fork to a merged PR.

By contributing you agree that your contributions are licensed under the [MIT License](../LICENSE).

---

## Ways to contribute

- **Extend the Grill-Me engine** — better question generation, fewer redundant questions
  (`server/src/domain/grill/`).
- **Sharpen the spec builder or workflow validator** — new invariants, better node suggestions
  (`server/src/domain/spec/`, `server/src/domain/workflow/`).
- **Improve the Python code generator** (`server/src/domain/codegen/`).
- **Improve the web studio** (`web/src/`).
- **Fix bugs** — start from an issue; if none exists, open one first.

If your change is large or user-facing, **open an issue to discuss it first.**

---

## Development setup

**Prerequisites:** **Node.js 22.5+** (`node:sqlite` requires it) and `git`.

```bash
# 1. Fork on GitHub, then clone your fork
git clone https://github.com/<you>/ai-workflow-builder.git
cd ai-workflow-builder

# 2. Install both workspaces
npm install

# 3. Confirm a clean baseline before you change anything
npm run lint && npm test && npm run build
```

If lint, tests, and build are all green on a fresh clone, your environment is correct. Don't build
on a red baseline.

## The architecture rule that matters most

The server is **hexagonal**: the `domain/` layer has **zero framework imports**, the `application/`
layer (services) orchestrates the domain and talks to repositories through ports, and the
`adapters/` layer (Express, SQLite) is plugged in at the composition root. When you contribute:

- **Put business logic in `domain/`.** It must not import Express, SQLite, or anything I/O.
- **Controllers hold no logic** — `routes.js` translates HTTP to service calls and back.
- **Services never touch HTTP**, and only they orchestrate across domain modules.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the [ADRs](adr/) for the reasoning.

## Tests

Tests use the built-in Node test runner (`node --test`) — no framework.

```bash
npm test                                   # whole server suite
npm test --workspace=server -- test/grillEngine.test.js   # one file
```

- **Domain and service changes** need unit tests in `server/test/`. The domain is dependency-free,
  so its tests are fast and require no mocks.
- **New or changed routes** must be reflected in [`openapi.yaml`](../openapi.yaml). The
  [contract test](../server/test/contract.test.js) fails CI if the routes and the spec drift — so
  update both together.

## Commits & PRs

- Use clear, conventional commit subjects (`feat:`, `fix:`, `chore:`, `docs:`).
- Before opening a PR, make sure `npm run lint && npm test && npm run build` is green.
- Keep PRs focused. Update docs in the same PR as the code they describe.

## CI

Every push and PR runs the [CI/CD pipeline](../.github/workflows/ci-cd.yml): `npm ci`, `npm run
lint`, `npm test`, `npm run build` — on **Node 22**. Deploy jobs run only on push to `main`.
