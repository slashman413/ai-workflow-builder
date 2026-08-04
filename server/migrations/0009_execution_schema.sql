-- 0009_execution_schema.sql
-- Increment 5: workflow execution engine — persistent run ledger, per-step
-- logs, and the one-click deploy ledger.
--
-- executions: one row per workflow run. `status` is the run state machine
-- (queued → running ⇄ paused → succeeded | failed | cancelled). `retry_of`
-- links a re-run to the execution it retries, so the history UI can group
-- attempts. `error_message` holds the terminal failure (or the first error
-- that aborted the run).
--
-- execution_steps: the per-step log (one row per node execution, including
-- retry attempts — `attempts` counts how many times the handler ran).
-- `input_data` / `output_data` are JSON snapshots: the input is the context
-- slice the node read (upstream outputs it depended on), the output is the
-- handler's return value. Sensitive values (API keys) are NEVER stored here:
-- the agent handler strips key material from what it logs. Rows cascade
-- with their execution.
--
-- deployments: one row per one-click deploy (or dry-run preview). `config`
-- is the generated platform config bundle (wrangler.toml / fly.toml /
-- Dockerfile) as JSON; `url` is the assigned deployment target.
-- `status` = dry_run | deploying | deployed | failed.

CREATE TABLE IF NOT EXISTS executions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  workflow_id   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued|running|paused|succeeded|failed|cancelled
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  error_message TEXT,
  retry_of      TEXT,                            -- execution id this run retries (null for fresh runs)
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_executions_org_created ON executions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_project ON executions (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS execution_steps (
  id            TEXT PRIMARY KEY,
  execution_id  TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  node_type     TEXT NOT NULL,
  status        TEXT NOT NULL,                   -- queued|running|success|error|skipped|cancelled
  input_data    TEXT,                            -- JSON snapshot of what the node read
  output_data   TEXT,                            -- JSON snapshot of what the node produced
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 1,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_execution_steps_exec ON execution_steps (execution_id, created_at ASC);

CREATE TABLE IF NOT EXISTS deployments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  platform      TEXT NOT NULL,                   -- cloudflare|fly|docker
  status        TEXT NOT NULL DEFAULT 'deploying', -- dry_run|deploying|deployed|failed
  config        TEXT NOT NULL DEFAULT '{}',      -- JSON bundle of generated platform config
  url           TEXT,
  error_message TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deployments_org ON deployments (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments (project_id, created_at DESC);
