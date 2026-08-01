-- 0006_billing_schema.sql
-- Increment 4: Stripe billing persistence for the $99/mo Team tier and
-- 14-day trials, keyed by tenant (org_id) — the same tenant identity the
-- auth choke point binds to every request.
--
-- billing: one row per org. `status` mirrors the SUBSCRIPTION status machine
-- (trialing | active | past_due | canceled | incomplete | unpaid), derived
-- from Stripe events and re-fetched subscription state. The webhook layer
-- upserts here; the API surface only reads.
--
-- billing_events: the idempotency ledger. Stripe delivers webhooks
-- at-least-once (and occasionally out of order); every processed event id is
-- recorded here so a replay is acknowledged without re-applying side
-- effects. PRIMARY KEY on event_id makes the dedupe atomic (insert fails
-- loudly on the second delivery).

CREATE TABLE IF NOT EXISTS billing (
  org_id                TEXT PRIMARY KEY,
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  plan                  TEXT NOT NULL DEFAULT 'free',
  status                TEXT NOT NULL DEFAULT 'none',  -- none|trialing|active|past_due|canceled|incomplete|unpaid
  current_period_end    TEXT,
  trial_end             TEXT,
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  org_id      TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_events_org ON billing_events (org_id, received_at);
