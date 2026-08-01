-- 0007_publish_schema.sql
-- Increment 4: GitHub publishing — per-org OAuth connections (repo scope)
-- and the publication ledger.
--
-- github_connections: the OAuth token for one org. The token is sealed with
-- the same AES-256-GCM envelope key as the vault (never stored in
-- plaintext); `scopes` records what GitHub granted (we request `repo`).
-- `login` is the connected GitHub account, used for repo URLs and the
-- "connected as @login" UI.
--
-- publications: one row per successful publish — the audit trail that ties
-- a project + workflow + spec to the remote repository it was pushed to.
-- The GitHub API is the source of truth for the repo itself; this table is
-- OUR record of what was scaffolded, when, by which tenant, and at what
-- latency (the <5s SLA is asserted by tests against the client call graph,
-- and recorded here per real publish for ops monitoring).

CREATE TABLE IF NOT EXISTS github_connections (
  org_id      TEXT PRIMARY KEY,
  login       TEXT NOT NULL,
  token_sealed TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT '[]',   -- JSON array, e.g. ["repo"]
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publications (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  repo_owner     TEXT NOT NULL,
  repo_name      TEXT NOT NULL,
  repo_url       TEXT NOT NULL,
  private        INTEGER NOT NULL DEFAULT 0,
  file_count     INTEGER NOT NULL,
  latency_ms     INTEGER NOT NULL,
  workflow_hash  TEXT NOT NULL,             -- sha256 of the workflow JSON (change detection)
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publications_org ON publications (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_publications_project ON publications (project_id, created_at);
