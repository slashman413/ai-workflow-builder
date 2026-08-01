-- 0003_tenant_scoping.sql
-- Multi-tenant isolation: every domain row is bound to an owning organization.
--
-- SQLite forbids `ADD COLUMN ... NOT NULL` without a DEFAULT, so legacy rows
-- (pre-tenant data) get `org_id = ''` — the empty tenant. There is no such
-- data in production yet (the workspace was never shipped), and the auth
-- choke point (`requireOrg`) rejects requests that are not bound to a real
-- org before they can ever reach the repositories.
--
-- The composite `(org_id, updated_at)` indexes are the workspace-list access
-- path: list-by-org ordered by recency, without ever scanning another
-- tenant's rows.

ALTER TABLE projects ADD COLUMN org_id TEXT NOT NULL DEFAULT '';
ALTER TABLE workflows ADD COLUMN org_id TEXT NOT NULL DEFAULT '';

-- grill_sessions: one row per grill round (the audit trail of the
-- clarification loop). Created here because the table did not exist in the
-- baseline schema — grill state previously lived only inside projects.answers.
CREATE TABLE IF NOT EXISTS grill_sessions (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round      INTEGER NOT NULL,
  answers    TEXT NOT NULL DEFAULT '{}',
  coverage   REAL NOT NULL DEFAULT 0,
  ready      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_org_updated ON projects (org_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_workflows_org_updated ON workflows (org_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_grill_sessions_org_updated ON grill_sessions (org_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_grill_sessions_project ON grill_sessions (project_id);
