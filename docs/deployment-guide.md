# Deployment Guide

How to ship `ai-workflow-builder`. Since 2026-08-09 the product is **self-hosted**:
buyers download the code (MIT) and run it on machines they control. The only
thing this repo deploys to a public host is the **static landing page** on
`workflow-builders.com`.

```
  workflow-builders.com
  ┌──────────────────────────────┐
  │ Cloudflare Pages             │   static landing page (web/landing/)
  │  — product intro             │   no Clerk · no API origin · no secrets
  │  — self-host quick start     │
  │  — Gumroad CTA               │
  └──────────────────────────────┘
```

The studio itself has no hosted multi-tenant backend anymore — see
[Part 2 — Self-hosting the studio](#part-2--self-hosting-the-studio).

---

## Part 1 — The demo landing page (Cloudflare Pages)

`workflow-builders.com` is a pure static page in [`web/landing/`](../web/landing)
(`index.html` + `styles.css` + the demo screenshot). It exists to convert
visitors: product intro, "How it works", self-host quick start, and a Gumroad
CTA (`https://slashmaster6.gumroad.com/l/amwkf`).

It has **zero runtime dependencies** — no Clerk, no API calls, no build-time
secrets. The `deploy-web` job in [`.github/workflows/ci-cd.yml`](../.github/workflows/ci-cd.yml)
publishes it on every push to `main`:

```bash
wrangler pages deploy web/landing --project-name ai-workflow-builder-web --branch=main
```

One-time wiring:

1. Create a Cloudflare Pages project named `ai-workflow-builder-web` (Direct Upload).
2. Add the DNS record `workflow-builders.com` → the Pages project (proxied).
3. Add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Only those two secrets are required. `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`,
and `FLY_API_TOKEN` are no longer used by CI.

Manual deploy (quick test):

```bash
cd /home/wayne/workspace/github/slashman413/ai-workflow-builder/
wrangler pages deploy web/landing \
  --project-name=ai-workflow-builder-web \
  --branch=main \
  --api-token="$(cat ~/.priv/ckw19810413-cloudflare-api-token)"
```

---

## Part 2 — Self-hosting the studio

The studio is an npm-workspaces monorepo: `server/` (Express + `node:sqlite`) and
`web/` (React + Vite). Buyers run it in minutes:

```bash
git clone https://github.com/slashman413/ai-workflow-builder.git   # or unzip the Gumroad download
cd ai-workflow-builder
npm install        # installs both workspaces
npm run dev        # API on :4000 + studio on :5173
```

Then open http://localhost:5173. The Vite dev server proxies `/api` to the local
backend, so there is no CORS to configure. **No Clerk key is needed**: without
`VITE_CLERK_PUBLISHABLE_KEY` the web app runs in mock-auth mode and the backend
accepts the dev tenant headers — the full prompt → grill → workflow flow works
out of the box. (Clerk mode is still supported for teams that want real
multi-tenant auth — see [`auth-production-setup.md`](./auth-production-setup.md).)

### Production-ish local run

```bash
npm run build      # web bundle → web/dist
npm start          # API in production mode (SQLite on disk)
```

### Run the API as a container

The repo-root [`Dockerfile`](../Dockerfile) is a multi-stage `node:22-slim` build
that ships the `server` workspace, runs as the unprivileged `node` user, and
declares a health check against `/api/health`:

```bash
docker build -t ai-workflow-builder-api .
docker run --rm -p 4000:4000 -v awb-data:/data ai-workflow-builder-api
curl http://localhost:4000/api/health
```

Serve `web/dist` with any static host (nginx, Caddy, `vite preview`) and point
`VITE_API_URL` at the container during the build.

### Railway (or any Docker host)

[`railway.toml`](../railway.toml) provides equivalent config — point Railway at
the repo, attach a volume for `/data`, and set the env vars below. Railway builds
the Dockerfile directly.

### Environment variables (server)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `4000` | Listen port. |
| `DB_FILE` | `./data/app.db` | SQLite path (auto-created). |
| `NODE_ENV` | `production` | Tightens the CORS allow-list to the canonical domain. |
| `CORS_ORIGINS` | — | Comma-separated override (e.g. add a staging/preview origin). |
| `USE_MEMORY` | — | `1` = non-persistent in-memory repo (not for production). |
| `AUTH_MODE` | `dev` | `clerk` = verify Clerk JWTs (`CLERK_SECRET_KEY` required). |
| `CLERK_SECRET_KEY` | — | Session JWT verification when `AUTH_MODE=clerk`. |
| `VAULT_KEK` | — | 32-byte base64 envelope key — seals LLM keys AND GitHub OAuth tokens. |
| `STRIPE_SECRET_KEY` | — | Enables Stripe checkout + subscription webhooks. |
| `STRIPE_WEBHOOK_SECRET` | — | `whsec_…` webhook signature verification. |
| `STRIPE_TEAM_PRICE_ID` | — | The Team tier price. |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth app id (repo-scoped publishing). |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth app secret. |
| `GITHUB_REDIRECT_URI` | — | OAuth callback (default `${API_ORIGIN}/api/github/callback`). |
| `POSTHOG_API_KEY` | — | PostHog product analytics (without it, captures are local-only no-ops). |

Optional features (billing, publishing, analytics) **fail closed**: with a
secret missing the corresponding endpoint answers `503 NOT_CONFIGURED`, so a
missing key can never crash the app.

---

## Required CI secrets

| Secret | Used by |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | `deploy-web` (landing page publish) |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-web` |

`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`, and `FLY_API_TOKEN` are **no
longer used** by CI (the landing page is static; the studio is self-hosted).
If the two Cloudflare secrets are absent, CI (`lint`/`test`/`build`) still runs
on every push and PR; only the `deploy-web` job — gated on `push` to `main` —
needs them.

---

## Operations (self-hosted)

- **Health:** `GET /api/health` returns status, service name, build version,
  uptime, and a live database readiness check (`db.ok`); it answers 503 with
  `status: degraded` when the database is unreachable.
- **Backups:** the entire state is the SQLite file (`DB_FILE`). Copy it out on a
  schedule while the server is stopped (or use `sqlite3 .backup`).
- **Ecosystem catalog sync (nightly):** the Agent Marketplace and Cognitive
  Lenses are mirrored from pinned upstreams (`slashman413/agency-agents` fork,
  `alchaincyf/nuwa-skill`) by `server/src/cli/sync-catalogs.js`. Run it nightly
  from the API host:
  `0 3 * * *  cd /srv/ai-workflow-builder && node server/src/cli/sync-catalogs.js --catalog all`
  `--dry-run` validates without writing; `--restore <id>` rolls back to a stored
  good snapshot; `--from-bundle` installs the bundled fixtures offline. First
  boot autoseeds from the bundle (`CATALOG_AUTOSEED=0` disables).
- **Upgrades:** `git pull && npm ci && npm run build && npm start`. Schema
  migrations in `server/migrations/` are applied automatically at boot.

---

## Archived

The old hosted-deployment plan (Fly.io API container + Clerk OAuth + Stripe) is
archived in [`docs/archive/`](./archive/): `fly.toml` and `DEPLOYMENT-RUNBOOK.md`.
Do not `fly launch` / `fly deploy` from them.
