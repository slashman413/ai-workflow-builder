-- 0002_project_indexes.sql
-- Support the list view (ORDER BY created_at DESC) with a covering index, and
-- speed up workflow lookups by project. Demonstrates that the migration
-- pipeline applies incremental schema changes on top of the baseline.

CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows (project_id);
