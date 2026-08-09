# Archived — Fly.io deployment (superseded)

Wayne's decision (2026-08-09): **AI Workflow Builder is a self-hosted product** (MIT,
download-and-run). The hosted demo at workflow-builders.com is now a **static landing
page** (`web/landing/`) — no Clerk, no API origin, no login wall.

The files in this folder describe the *previous* hosted-deployment plan (Cloudflare
Pages SPA + Fly.io API container + Clerk OAuth) and are archived so nobody
accidentally re-triggers a Fly.io deploy:

| File | What it was | Status |
|------|-------------|--------|
| `fly.toml` | Fly.io app manifest for the API container | **Archived** — do not `fly launch` / `fly deploy` from it |
| `DEPLOYMENT-RUNBOOK.md` | Full Clerk + Fly.io + Stripe runbook | **Archived** — superseded by `docs/deployment-guide.md` |

## Current deployment (as of 2026-08-09)

- **`workflow-builders.com`** → static landing page, `web/landing/`, deployed by
  `.github/workflows/ci-cd.yml` (`deploy-web` job → Cloudflare Pages project
  `ai-workflow-builder-web`). No build-time secrets needed.
- **The product itself** → self-hosted by buyers from the repo. No accounts, no
  SaaS. See README "Quick start" (`npm install && npm run dev`).
