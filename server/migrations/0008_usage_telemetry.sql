-- 0008_usage_telemetry.sql
-- Increment 4 (continuation): monthly usage quotas and the local
-- privacy-preserving analytics log.
--
-- usage_events — append-only monthly counters (org, metric, period). The
-- Free tier is capped at 10 `grill_session_started` per calendar month;
-- Team/trial is unlimited. The upsert is atomic (UNIQUE on org+metric+period),
-- so concurrent session opens can never double-count.
--
-- telemetry_events — local append-only analytics log keyed by a
-- PSEUDONYMOUS org hash (sha256(org_id) truncated), never the org id, user
-- id, prompt text, or any secret. The props column holds allowlisted
-- metadata only (tier, mode, counts) — the TelemetryService strips anything
-- that could identify a person or leak a prompt/API key.

CREATE TABLE IF NOT EXISTS usage_events (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  metric     TEXT NOT NULL,               -- 'grill_session_started' | 'export_completed'
  period     TEXT NOT NULL,               -- 'YYYY-MM' — the quota window
  amount     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, metric, period)
);
CREATE INDEX IF NOT EXISTS idx_usage_events_org_metric ON usage_events (org_id, metric, period);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id         TEXT PRIMARY KEY,
  org_hash   TEXT NOT NULL,               -- sha256(org_id)[:16] — pseudonymous
  event      TEXT NOT NULL,
  props      TEXT NOT NULL DEFAULT '{}',  -- allowlisted metadata only
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_created ON telemetry_events (created_at);
