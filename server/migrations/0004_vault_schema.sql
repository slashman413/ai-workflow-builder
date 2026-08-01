-- 0004_vault_schema.sql
-- Envelope-encrypted LLM provider key vault.
--
-- Each row stores a provider API key for one organization. The key is
-- encrypted twice (envelope encryption):
--
--   wrapped_key  = AES-256-GCM(org DEK, plaintext provider key)
--   wrapped_dek  = AES-256-GCM(environment KEK, org DEK)
--
-- The DEK (Data Encryption Key) is per-organization; the KEK (Key Encryption
-- Key) lives in the environment / secrets manager, never in the database.
-- An attacker who exfiltrates the whole database still cannot recover any
-- plaintext key without the KEK, which is not stored anywhere on disk.
--
-- `masked_key` is the only key material ever returned by the read API: a
-- preview like `sk-abc…wxyz` derived at store time. `wrapped_key` and
-- `wrapped_dek` are write-only — no endpoint ever returns them.

CREATE TABLE IF NOT EXISTS vault_keys (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  provider    TEXT NOT NULL,              -- openai | anthropic | gemini
  label       TEXT NOT NULL,              -- human-readable name chosen by the user
  key_handle  TEXT NOT NULL UNIQUE,       -- opaque id referenced by the executor
  masked_key  TEXT NOT NULL,              -- e.g. sk-proj-ab…9f2c (derived at store time)
  wrapped_dek TEXT NOT NULL,              -- KEK-wrapped org DEK (base64)
  wrapped_key TEXT NOT NULL,              -- DEK-wrapped provider key (base64)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vault_keys_org ON vault_keys (org_id);
