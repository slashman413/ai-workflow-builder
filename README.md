# ai-workflow-builder

> Turn a single natural-language prompt into a validated, dependency-checked multi-agent AI workflow. Ambiguity is resolved up front by an interactive **Grill-Me** spec loop — not discovered later in production.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node 22.5+](https://img.shields.io/badge/node-22.5%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![CI](https://img.shields.io/badge/CI-eslint%20%7C%20node%3Atest%20%7C%20vite%20build-informational.svg)](.github/workflows/ci-cd.yml)

This is the codebase behind **[workflow-builders.com](https://workflow-builders.com)** — a
Node.js + React studio for designing production multi-agent systems.

---

## Why this exists

Building multi-agent AI pipelines today means one of two bad options: hand-write brittle glue
code, or write an exhaustive spec before you know what you need. Ambiguous prompts get silently
mis-interpreted and fail in production.

`ai-workflow-builder` closes that gap. You give it **one plain-language prompt**. It interrogates
you (the **Grill-Me** loop) only about the parts that are genuinely ambiguous — the goal, the
inputs, the shape of the output, how success is measured — resolves those into a versioned spec,
scaffolds a validated workflow DAG, and generates runnable Python orchestration code from it.

## Stack

This is a single **npm-workspaces monorepo**, not a Python CLI:

| Workspace | What it is | Key tech |
|-----------|------------|----------|
| **`server/`** | The REST API | Node 22 · Express 4 · `node:sqlite` (built-in) |
| **`web/`** | The single-page studio | React 18 · Vite 6 |

The server is a **hexagonal (ports & adapters) modular monolith**. The `domain/` layer — the
Grill engine, spec builder, workflow validator, topological sort, executor, and Python code
generator — has **zero framework imports** and is covered by the bulk of the test suite. Express
and SQLite are adapters plugged in at the composition root (`server/src/index.js`).

> **Node 22.5+ is required.** Persistence uses the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html)
> module, which only exists on Node ≥ 22.5. On older Node the SQLite adapter — and its tests —
> cannot load. CI pins Node 22.

## Quick start

```bash
git clone https://github.com/slashman413/ai-workflow-builder.git
cd ai-workflow-builder
npm install              # installs both workspaces

npm run dev              # server (:4000) + Vite dev server (:5173) together
```

Then open http://localhost:5173. The Vite dev server proxies `/api` to the backend, so there is
no CORS to configure locally.

### Everyday commands

| Command | Does |
|---------|------|
| `npm run dev` | Run API + web dev server concurrently |
| `npm run dev:server` / `npm run dev:web` | Run one side only |
| `npm test` | Run the server test suite (`node --test`) |
| `npm run lint` | ESLint the server |
| `npm run build` | Build the web SPA to `web/dist/` |
| `npm start` | Start the API in production mode (SQLite) |

### Configuration (server)

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `4000` | API listen port |
| `DB_FILE` | `./data/app.db` | SQLite database path (auto-created) |
| `USE_MEMORY` | — | Set to `1` to use the non-persistent in-memory repo |
| `NODE_ENV` | — | `production` tightens the CORS allow-list |
| `CORS_ORIGINS` | — | Comma-separated origin allow-list override (defaults: production → `https://workflow-builders.com`; dev → localhost Vite origins). `https://*.pages.dev` preview deploys and `https://*.workflow-builders.com` subdomains are always honored |
| `AUTH_MODE` | `test` | `clerk` verifies every request's session JWT with Clerk (`CLERK_SECRET_KEY` required) |
| `VAULT_KEK` | — | 32-byte base64 envelope key for the LLM key vault (required in production) |
| `STRIPE_SECRET_KEY` | — | Enables live Stripe billing (Team tier, $99/mo) |
| `STRIPE_WEBHOOK_SECRET` | — | `whsec_…` for signature-verified webhooks (required for billing) |
| `STRIPE_TEAM_PRICE_ID` | — | Stripe Price id for the Team tier |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | GitHub OAuth app for repo publishing (repo scope) |
| `GITHUB_REDIRECT_URI` | — | OAuth callback URL (defaults to `${API_ORIGIN}/api/github/callback`) |
| `POSTHOG_API_KEY` | — | Enables PostHog product analytics (privacy-preserving, allowlisted props only) |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingestion host |

## The REST API

All endpoints are served under `/api`. The machine-readable contract lives in
[`openapi.yaml`](openapi.yaml) and is kept honest by an automated
[contract test](server/test/contract.test.js) that fails CI if the routes and the spec ever drift.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness + readiness probe (status, version, uptime, DB check; 503 when DB is down) |
| `POST` | `/api/projects` | Create a project from a prompt |
| `GET` | `/api/projects` | List projects |
| `GET` | `/api/projects/{id}` | Fetch a project |
| `DELETE` | `/api/projects/{id}` | Delete a project |
| `GET` | `/api/projects/{id}/grill` | Get the next Grill-Me questions |
| `POST` | `/api/projects/{id}/answers` | Submit answers, advancing the spec |
| `POST` | `/api/projects/{id}/workflow/scaffold` | Scaffold a workflow DAG from the spec |
| `GET` | `/api/projects/{id}/workflow` | Fetch the current workflow |
| `PUT` | `/api/projects/{id}/workflow` | Save/replace the workflow (validated) |
| `POST` | `/api/workflow/preflight` | Static pre-flight AST validation (cycles, reachability, schema, tool boundaries, security) |
| `POST` | `/api/workflow/simulate` | SAFE execution preview (static validation + mock simulation) |
| `POST` | `/api/projects/{id}/publish` | Export the compiled workflow to GitHub (Team tier) |
| `GET` | `/api/projects/{id}/publications` | Publication ledger for a project |
| `GET` | `/api/github/auth-url` | Start the GitHub OAuth dance (repo scope) |
| `GET` | `/api/github/status` | GitHub connection status + recent publications |
| `DELETE` | `/api/github/connection` | Disconnect the org's GitHub account |
| `GET` | `/api/billing` | Current Stripe subscription state |
| `GET` | `/api/billing/entitlement` | Effective tier + monthly Grill usage (free cap / team gates) |
| `POST` | `/api/billing/checkout` | Create a Stripe Checkout session (Team $99/mo) |
| `POST` | `/api/billing/portal` | Stripe billing portal link |
| `POST` | `/api/billing/webhook` | Stripe webhook (public, signature-verified, idempotent) |
| `POST` | `/api/telemetry/events` | Privacy-preserving analytics capture (allowlisted props only) |

See [`docs/api-reference.md`](docs/api-reference.md) for request/response shapes and error codes.

## Monetization, publishing & analytics (Increment 4)

- **Pre-flight validator** — `POST /api/workflow/preflight` runs the full static gate before any
  export: structural DAG checks, reachability (islands, unreachable nodes), schema parameter
  matching, tool-boundary constraints against the marketplace allow-list, and the security
  boundary reassertion (executable payload markers are refused; nothing ever executes).
- **Code generator** — the compiled Python project now ships typed interfaces (`interfaces.py`),
  LLM retry + fallback handlers (`LLM_MAX_RETRIES`, `DEFAULT_AGENT_FALLBACK`,
  `main(continue_on_error=True)`), GitHub Actions CI (`.github/workflows/ci.yml`), `.gitignore`
  and a spec scaffold (`spec.yaml`, `workflow.json`).
- **GitHub publishing** — OAuth (repo scope) connects the user's account; the git-data API
  scaffolds a repository in 4 requests (<5s SLA). Tokens are sealed with the vault's envelope
  key; every publish is recorded in the `publications` ledger.
- **Stripe billing** — Team tier at $99/mo with a 14-day trial. Webhooks are signature-verified,
  idempotent (event-id ledger) and out-of-order safe (state is re-fetched, never trusted from
  the event). Entitlement gates: Free = 10 Grill sessions/month + mocked previews; Team/trial =
  unlimited Grill loops + repository export.
- **PostHog analytics** — the user funnel (grill kickoff, lens selections, export completions)
  is captured with pseudonymous org hashes and an allowlisted property set. Prompt text, API
  keys and free-form content are structurally impossible to log.

### Pre-GA security gates

```bash
node scripts/security/secret-scan.mjs      # HIGH/MEDIUM/LOW secret patterns across the tree
node scripts/security/coverage-gate.mjs    # line coverage ≥ 90% (96% today)
bash scripts/security/security-gate.sh     # lint + test + build + secret scan + coverage
```

### Increment 4 environment variables

| Variable | Required | Used for |
|----------|----------|----------|
| `STRIPE_SECRET_KEY` | for billing | Stripe API (server-side operations) |
| `STRIPE_WEBHOOK_SECRET` | for billing | Webhook signature verification (`whsec_…`) |
| `STRIPE_TEAM_PRICE_ID` | for billing | The $99/mo Team tier price (`price_…`) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | for publishing | GitHub OAuth app (repo scope) |
| `GITHUB_REDIRECT_URI` | optional | OAuth callback URL (defaults to `<API_ORIGIN>/api/github/callback`) |
| `POSTHOG_API_KEY` / `POSTHOG_HOST` | optional | Product analytics (falls back to local-only telemetry) |

In production the server fails closed: billing/publishing endpoints answer 503 until the
relevant credentials are set. In development, without these variables, the API still serves the
full pre-auth flow, the Grill loop, mock simulation, and the pre-flight validator.

## How it works

```
   prompt
     │
     ▼
┌──────────────┐   questions   ┌──────────────────┐
│  Prompt      │ ───────────▶  │  Grill-Me loop   │
│  ingestion   │ ◀───────────  │ (clarify spec)   │
└──────────────┘   answers     └───────┬──────────┘
                                        │ resolved, versioned spec
                                        ▼
                               ┌──────────────────┐
                               │ Workflow scaffold│  validated DAG:
                               │  + validator     │  no cycles, no dangling deps
                               └───────┬──────────┘
                                        ▼
                               ┌──────────────────┐
                               │ Python code-gen  │  runnable orchestration
                               └──────────────────┘
```

## Deployment (Cloudflare-native hybrid)

Production runs as two independently deployed halves:

- **`workflow-builders.com`** → the React SPA on **Cloudflare Pages** (edge CDN, static build of
  `web/dist/`). The deploy injects `VITE_API_URL=https://api.workflow-builders.com/api` at build
  time so the SPA calls the API on its own origin.
- **`api.workflow-builders.com`** → the Express API as a container on **Fly.io** (or Railway),
  built from the production [`Dockerfile`](Dockerfile) with SQLite persisted to a mounted volume.

Both halves ship from the CI/CD pipeline in [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml)
on push to `main`, gated behind a green lint/test/build. Container config:
[`fly.toml`](fly.toml), [`railway.toml`](railway.toml). SPA config for the Pages
edge: [`wrangler.toml`](wrangler.toml) (project definition),
[`web/public/_redirects`](web/public/_redirects) (`/* /index.html 200` SPA
fallback), and [`web/public/_headers`](web/public/_headers) (security headers
+ asset caching) — both copied into the build by Vite. Full runbook:
[`docs/deployment-guide.md`](docs/deployment-guide.md).

## Documentation

| Guide | Read it to… |
|-------|-------------|
| [Usage Guide](docs/usage-guide.md) | Run locally and build your first workflow end to end |
| [API Reference](docs/api-reference.md) | Call every endpoint with request/response/error detail |
| [Architecture](docs/ARCHITECTURE.md) | Understand the hexagonal layering and module seams |
| [Domain Model](docs/DOMAIN.md) | Learn the ubiquitous language (project, spec, workflow, node) |
| [Deployment Guide](docs/deployment-guide.md) | Ship to Cloudflare Pages + Fly.io/Railway |
| [Contributing](docs/CONTRIBUTING.md) | Set up a dev environment and land a change |
| [ADRs](docs/adr/) | The recorded architecture decisions behind the above |

## Attribution

Ecosystem integrations and their licenses are tracked in [`ATTRIBUTIONS.md`](ATTRIBUTIONS.md).

## License

[MIT](LICENSE).
