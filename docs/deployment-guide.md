# Deployment Guide

This guide shows how to run the `ai-workflow-builder` **service** (the FastAPI app) — for a team, in CI, or in production. If you only want the CLI on your laptop, you don't need any of this; see the [Usage Guide](usage-guide.md).

**Audience:** an engineer deploying and operating the service.
**You'll cover:** running via Docker, every environment variable, production hardening, health checks, backups, and upgrades.

---

## Architecture at a glance

The service is a single stateless FastAPI process backed by a SQLite database (default) or PostgreSQL. It calls out to:

- **Model providers** (OpenAI / Anthropic / Gemini) for spec resolution and code generation
- **GitHub** (only when publishing)

Because the process is stateless apart from the database, you can run one container for a small team, or several behind a load balancer for a larger one — as long as they share the same database.

```
        clients (CLI / HTTP)
                │
                ▼
        ┌───────────────┐        ┌──────────────────┐
        │  FastAPI app  │ ─────▶ │ model providers  │
        │ (uvicorn)     │        └──────────────────┘
        │               │ ─────▶ ┌──────────────────┐
        └──────┬────────┘        │      GitHub      │
               ▼                 └──────────────────┘
        ┌───────────────┐
        │ DB (SQLite /  │
        │  PostgreSQL)  │
        └───────────────┘
```

---

## Option A: Docker (recommended)

### 1. Pull or build the image

```bash
# Build from the repo
docker build -t ai-workflow-builder:1.0.0 .
```

### 2. Create an env file

Create `awb.env` (never commit it):

```env
# --- required ---
AWB_API_KEYS=change-me-strong-key-1,change-me-strong-key-2
OPENAI_API_KEY=sk-...
# --- optional providers ---
# ANTHROPIC_API_KEY=...
# GEMINI_API_KEY=...
# --- publishing (optional) ---
GITHUB_TOKEN=ghp_...
# --- data ---
AWB_DATABASE_URL=sqlite:////data/awb.db
```

### 3. Run

```bash
docker run -d --name awb \
  --env-file awb.env \
  -p 8000:8000 \
  -v awb-data:/data \
  ai-workflow-builder:1.0.0
```

### 4. Verify

```bash
curl http://localhost:8000/health
# {"status":"ok","version":"1.0.0","checks":{"database":"ok","model_provider":"ok"}}
```

Swagger UI is now at `http://localhost:8000/docs`.

### docker-compose (with PostgreSQL)

```yaml
services:
  awb:
    image: ai-workflow-builder:1.0.0
    env_file: awb.env
    environment:
      AWB_DATABASE_URL: postgresql://awb:awb@db:5432/awb
    ports: ["8000:8000"]
    depends_on: [db]
    restart: unless-stopped
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: awb
      POSTGRES_PASSWORD: awb
      POSTGRES_DB: awb
    volumes: ["awb-pg:/var/lib/postgresql/data"]
    restart: unless-stopped
volumes:
  awb-pg:
```

---

## Option B: Run from source

For development or a bare-metal host. The project uses **Poetry**.

```bash
git clone https://github.com/slashman413/ai-workflow-builder.git
cd ai-workflow-builder
poetry install --no-dev            # or `poetry install` to include dev tools

# initialize the database schema
poetry run awb db upgrade

# serve
poetry run uvicorn ai_workflow_builder.api:app --host 0.0.0.0 --port 8000 --workers 4
```

Put a real ASGI setup in front for production: run `uvicorn` under a process manager (systemd, supervisor) or use `gunicorn -k uvicorn.workers.UvicornWorker`.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWB_API_KEYS` | **yes** | – | Comma-separated API keys accepted on `/api/v1/*`. Rotate by adding a new key, migrating clients, then removing the old one. |
| `OPENAI_API_KEY` | one provider required | – | OpenAI key. |
| `ANTHROPIC_API_KEY` | one provider required | – | Anthropic key. |
| `GEMINI_API_KEY` | one provider required | – | Google Gemini key. |
| `AWB_MODEL_PROVIDER` | no | first available | Force a provider: `openai` \| `anthropic` \| `gemini`. |
| `GITHUB_TOKEN` | for publishing | – | PAT with `repo` scope. Without it, `/publish` returns `422 PUBLISH_TOKEN_MISSING`. |
| `AWB_DATABASE_URL` | no | `sqlite:////data/awb.db` | SQLAlchemy URL. Use `postgresql://…` for multi-instance deployments. |
| `AWB_RATE_LIMIT_PER_MINUTE` | no | `60` | Per-key request cap. |
| `AWB_LOG_LEVEL` | no | `INFO` | `DEBUG` \| `INFO` \| `WARNING` \| `ERROR`. |
| `AWB_CORS_ORIGINS` | no | (none) | Comma-separated allowed origins if calling from a browser. |
| `AWB_MAX_CONCURRENT_BUILDS` | no | `4` | Max builds running at once; excess are queued. |

> **Secrets handling.** All provider keys and `GITHUB_TOKEN` live only in the server's environment. They are never accepted in, or returned by, the API. Store them in your platform's secret manager, not in the image.

---

## Production hardening checklist

- [ ] **Strong API keys.** Generate `AWB_API_KEYS` values with `openssl rand -hex 32`. One key per client so you can revoke individually.
- [ ] **TLS.** Terminate HTTPS at a reverse proxy (nginx, Caddy, or your cloud LB). Do not expose plain `:8000` publicly.
- [ ] **PostgreSQL for >1 instance.** SQLite is fine for a single container; switch to Postgres before you scale out.
- [ ] **Restrict CORS.** Set `AWB_CORS_ORIGINS` to your exact frontend origins, never `*`, if the API is browser-facing.
- [ ] **Least-privilege GitHub token.** Use a fine-grained PAT scoped to the target org/repos only.
- [ ] **Resource limits.** Cap container CPU/memory; tune `AWB_MAX_CONCURRENT_BUILDS` to your host.
- [ ] **Persist `/data`** (or your Postgres volume) so workflow history and artifacts survive restarts.

## Health, readiness, and probes

`GET /health` returns `200` only when the database and at least one model provider are reachable, otherwise `503`. Wire it to your orchestrator:

```yaml
# Kubernetes
livenessProbe:  { httpGet: { path: /health, port: 8000 }, initialDelaySeconds: 10, periodSeconds: 15 }
readinessProbe: { httpGet: { path: /health, port: 8000 }, initialDelaySeconds: 5,  periodSeconds: 10 }
```

## Logging & observability

Logs are structured JSON on stdout (level via `AWB_LOG_LEVEL`); collect them with your platform's log driver. Each log line carries the `workflow_id` so you can trace a single build end to end. Prometheus metrics are exposed at `/metrics` (unauthenticated on the internal port) — scrape `awb_builds_total`, `awb_build_duration_seconds`, and `awb_test_pass_ratio`.

## Backups

Everything durable is in the database (`AWB_DATABASE_URL`) and the artifacts directory under `/data`.

```bash
# SQLite
docker run --rm -v awb-data:/data -v "$PWD:/backup" alpine \
  sh -c "cp /data/awb.db /backup/awb-$(date +%F).db"

# PostgreSQL
docker exec awb-db pg_dump -U awb awb > awb-$(date +%F).sql
```

Restore by stopping the service, replacing the file / restoring the dump, and starting again.

## Upgrades

The build ships a versioned schema; migrations are forward-only.

```bash
docker pull ai-workflow-builder:<new-version>
docker stop awb && docker rm awb
# run the migration (idempotent), then start the new image
docker run --rm --env-file awb.env -v awb-data:/data ai-workflow-builder:<new-version> awb db upgrade
docker run -d --name awb --env-file awb.env -p 8000:8000 -v awb-data:/data ai-workflow-builder:<new-version>
```

Always back up the database before upgrading. Check the release notes for breaking changes; deprecated API behavior is retained for one minor version before removal.

## Common deployment failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `/health` returns `503`, `checks.model_provider: "error"` | No provider key, or the provider is unreachable. | Confirm the key env var is set and egress to the provider is allowed. |
| Every `/api/v1/*` call returns `401` | `AWB_API_KEYS` unset or client sending the wrong key. | Set the env var; send `Authorization: Bearer <key>`. |
| `publish` returns `422` | `GITHUB_TOKEN` not configured. | Provide a `repo`-scoped token and restart. |
| Data lost on restart | `/data` (or Postgres volume) not persisted. | Mount a named volume as shown above. |
| Builds queue and never start | `AWB_MAX_CONCURRENT_BUILDS` too low or host starved. | Raise the limit and/or give the container more CPU. |
