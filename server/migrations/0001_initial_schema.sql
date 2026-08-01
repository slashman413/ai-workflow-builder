-- 0001_initial_schema.sql
-- Baseline schema: projects and their compiled workflows.
-- Each migration is applied exactly once, in filename order, inside a
-- transaction by the boot-time runner (see adapters/persistence/migrate.js).

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  prompt     TEXT NOT NULL,
  answers    TEXT NOT NULL DEFAULT '{}',
  spec       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workflow   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
