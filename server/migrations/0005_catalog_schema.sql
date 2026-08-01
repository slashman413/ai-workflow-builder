-- 0005_catalog_schema.sql
-- Increment 3: ecosystem catalog (agency-agents personas + nuwa-skill lenses)
-- and grill-session financial-DoS guardrail counters.
--
-- The catalog tables hold the *last-known-good snapshot* of the pinned
-- ecosystem mirrors. A sync writes a new catalog_versions row first; only a
-- fully committed snapshot replaces the rows of the previous one (the
-- repository performs the whole swap inside one transaction). If parsing or
-- validation fails, a `failed` version row is recorded and the previously
-- committed rows are left untouched — the API keeps serving them.
--
-- catalog_versions.payload holds the FULL parsed catalog JSON (divisions,
-- tools, personas or lenses) exactly as installed. It is what `restore()`
-- re-installs when the operator rolls back to a good snapshot, and it
-- carries the division/tool metadata the marketplace renders.
--
-- grill_sessions gains the two cumulative counters backing the guardrails:
--   turns       — how many answer rounds the clarification loop has consumed
--   tokens_used — estimated LLM tokens burned across the session
-- Both are ceilings (turns <= 5, tokens <= 15,000) enforced by the service
-- layer, which answers HTTP 429 when a request would exceed either.

ALTER TABLE grill_sessions ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE grill_sessions ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS catalog_versions (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,               -- 'agency-agents' | 'nuwa-skill'
  version    TEXT NOT NULL,               -- pinned fingerprint (git short hash or content digest)
  status     TEXT NOT NULL,               -- 'ok' | 'partial' | 'failed'
  counts     TEXT NOT NULL DEFAULT '{}',  -- JSON { personas, lenses, divisions, tools }
  error      TEXT,                        -- last sync failure message (failed/partial)
  payload    TEXT,                        -- full installed catalog JSON (ok rows; restore source)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_versions_source ON catalog_versions (source, created_at);

CREATE TABLE IF NOT EXISTS personas (
  id          TEXT PRIMARY KEY,           -- 'agency-agents:<division>/<slug>' (full API id)
  source      TEXT NOT NULL,
  version_id  TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  division    TEXT NOT NULL,              -- division dir key (engineering, sales, ...)
  slug        TEXT NOT NULL,              -- file stem, e.g. 'backend-architect'
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  emoji       TEXT,
  color       TEXT,
  vibe        TEXT,
  tools       TEXT NOT NULL DEFAULT '[]', -- JSON array of tool ids (permission tags)
  body        TEXT NOT NULL,              -- markdown body after the YAML frontmatter
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personas_source_version ON personas (source, version_id);
CREATE INDEX IF NOT EXISTS idx_personas_division ON personas (division);

CREATE TABLE IF NOT EXISTS lenses (
  id          TEXT PRIMARY KEY,           -- 'nuwa-skill:<slug>' (full API id)
  source      TEXT NOT NULL,
  version_id  TEXT NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  fidelity    TEXT,                       -- FIDELITY.md body when present
  body        TEXT NOT NULL,              -- SKILL.md body after the YAML frontmatter
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lenses_source_version ON lenses (source, version_id);
