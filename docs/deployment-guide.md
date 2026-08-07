# Deployment Guide

How to ship `ai-workflow-builder` to production. The app deploys as **two independent halves**
following a Cloudflare-native hybrid model:

- **`workflow-builders.com`** — the React SPA on **Cloudflare Pages** (static, edge CDN).
- **`api.workflow-builders.com`** — the Express API as a **container** on **Fly.io** (or Railway),
  with SQLite persisted to a mounted volume.

Both are shipped by the CI/CD pipeline in [`.github/workflows/ci-cd.yml`](../.github/workflows/ci-cd.yml)
on push to `main`, gated on a green lint/test/build.

```
      browser
        │
        ▼
  workflow-builders.com          api.workflow-builders.com
  ┌────────────────────┐  /api   ┌────────────────────────┐
  │ Cloudflare Pages   │ ──────▶ │ Express (Fly.io/Railway)│
  │ (static web/dist)  │         │  + node:sqlite volume   │
  └────────────────────┘         └────────────────────────┘
```

---

## Part 1 — The API container

The API is a pure Node 22 service: the only runtime dependency is Express, and persistence is the
built-in `node:sqlite` (no native module to compile). The production image is defined by the
repo-root [`Dockerfile`](../Dockerfile) — a multi-stage `node:22-slim` build that ships only the
`server` workspace and its production deps, runs as the unprivileged `node` user, and declares a
container health check against `/api/health`.

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `4000` | Listen port. |
| `DB_FILE` | `/data/app.db` (image) | SQLite path. Point at the mounted volume. |
| `NODE_ENV` | `production` | Tightens the CORS allow-list to the canonical domain. |
| `CORS_ORIGINS` | — | Comma-separated override (e.g. add a staging/preview origin). |
| `USE_MEMORY` | — | `1` = non-persistent in-memory repo (not for production). |

#### Secrets (Increment 4 — billing, publishing, analytics)

| Var | Required? | Purpose |
|-----|-----------|---------|
| `CLERK_SECRET_KEY` | Yes (production) | Session JWT verification (`AUTH_MODE=clerk`). |
| `VAULT_KEK` | Yes (production) | 32-byte base64 envelope key — seals LLM keys AND GitHub OAuth tokens. |
| `STRIPE_SECRET_KEY` | For billing | Enables live Stripe checkout + subscription webhooks. |
| `STRIPE_WEBHOOK_SECRET` | For billing | `whsec_…` — webhook signature verification (raw-body route). |
| `STRIPE_TEAM_PRICE_ID` | For billing | The Team tier price (test mode: `price_…` from the dashboard). |
| `GITHUB_CLIENT_ID` | For publishing | GitHub OAuth app id (repo scope). |
| `GITHUB_CLIENT_SECRET` | For publishing | GitHub OAuth app secret. |
| `GITHUB_REDIRECT_URI` | — | OAuth callback (default `${API_ORIGIN}/api/github/callback`). |
| `POSTHOG_API_KEY` | — | PostHog product analytics (privacy-preserving; without it, captures are local-only no-ops). |

Billing, publishing and analytics all **fail closed**: with a secret missing
the corresponding feature answers `503 NOT_CONFIGURED` (billing), the OAuth
dance refuses to start (publishing), and telemetry silently stays
local-only — the app never crashes and never degrades security.

### Build & run locally

```bash
docker build -t ai-workflow-builder-api .
docker run --rm -p 4000:4000 -v awb-data:/data ai-workflow-builder-api
curl http://localhost:4000/api/health
```

### Fly.io

Config lives in [`fly.toml`](../fly.toml). First-time setup:

```bash
fly launch --no-deploy          # or `fly apps create` if the app exists
fly volumes create awb_data --size 1   # persistent SQLite volume
fly deploy
```

CI then keeps it deployed automatically: the `deploy-api` job runs `flyctl deploy --remote-only`
using the `FLY_API_TOKEN` secret. Mount the volume at `/data` so `DB_FILE=/data/app.db` survives
restarts and redeploys.

### Railway

[`railway.toml`](../railway.toml) provides the equivalent config. Point Railway at the repo, attach
a volume for `/data`, and set the same env vars. Railway builds the Dockerfile directly.

---

## Part 2 — The web SPA (Cloudflare Pages)

The SPA is a static Vite build. In production it must call the API on its own origin **and** sign
users in with a Clerk **production** instance, so the build injects both:

```bash
VITE_API_URL=https://api.workflow-builders.com/api \
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...            \
  npm run build
# output: web/dist/
```

> ⚠️ **`VITE_CLERK_PUBLISHABLE_KEY` must be a `pk_live_…` production key.** A
> development key (`pk_test_…`) only works on `localhost`/`*.accounts.dev`; on
> `workflow-builders.com` Clerk's dev-browser handshake fails and GitHub/Google
> sign-in silently never works. Full Clerk production setup (DNS, OAuth apps,
> secrets) is in [`auth-production-setup.md`](./auth-production-setup.md). The
> SPA renders a "Sign-in is misconfigured" banner if a dev key reaches prod.

The `deploy-web` CI job builds with those env vars and publishes `web/dist` to Cloudflare Pages via
`cloudflare/pages-action`, using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.

To wire it up once:

1. Create a Cloudflare Pages project named `ai-workflow-builder-web` (Direct Upload / CI).
2. Add the DNS records: `workflow-builders.com` → the Pages project;
   `api.workflow-builders.com` → the Fly.io/Railway app.
3. Add the four repository secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `FLY_API_TOKEN`, and — if using Railway — its token).

---

## Required CI secrets

| Secret | Used by |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | `deploy-web` (Pages publish) |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-web` |
| `VITE_CLERK_PUBLISHABLE_KEY` | `deploy-web` (baked into the bundle — **must be `pk_live_…`**, see [`auth-production-setup.md`](./auth-production-setup.md)) |
| `VITE_API_URL` | `deploy-web` (absolute API base baked into the bundle) |
| `FLY_API_TOKEN` | `deploy-api` (Fly deploy) |

If the secrets are absent, the CI (`lint/test/build`) still runs on every push and PR; only the
deploy jobs — which are gated on `push` to `main` — require them.

---

## Operations

- **Health:** `GET /api/health` returns status, service name, build version, uptime, and a live
  database readiness check (`db.ok`); it answers 503 with `status: degraded` when the database is
  unreachable, so the container `HEALTHCHECK` and Fly checks restart or fail the instance over.
- **Backups:** the entire state is the SQLite file on the volume. Snapshot the volume (Fly volume
  snapshots) or copy `/data/app.db` out on a schedule.
- **Ecosystem catalog sync (nightly):** the Agent Marketplace and Cognitive Lenses are mirrored
  from pinned upstreams (`slashman413/agency-agents` fork, `alchaincyf/nuwa-skill`) by
  `server/src/cli/sync-catalogs.js`. The pipeline is fetch → parse → validate → transactional
  install; every success writes an immutable snapshot and every failure records a `failed` version
  row while the last-good catalog stays live, so a broken upstream can never take the site down.
  Run it nightly from the API host (or via the container's cron service):
  `0 3 * * *  cd /srv/ai-workflow-builder && node server/src/cli/sync-catalogs.js --catalog all`
  Pin an immutable commit instead of tracking `main` with `--ref <full-sha>` (per-catalog pins
  require one invocation per catalog). `--dry-run` validates without writing; `--restore <id>`
  rolls back to a stored good snapshot; `--from-bundle` installs the bundled fixtures offline.
  First boot autoseeds from the bundle (`CATALOG_AUTOSEED=0` disables) so the marketplace works
  before any sync.
- **Upgrades:** push to `main`; CI rebuilds and redeploys both halves. Schema migrations in
  `server/migrations/` are applied automatically at boot before traffic is served.
