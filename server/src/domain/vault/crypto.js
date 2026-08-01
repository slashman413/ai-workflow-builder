/**
 * crypto.js — AES-256-GCM envelope-encryption primitives for the key vault.
 *
 * Two key layers:
 *
 *   - KEK (Key Encryption Key): a 32-byte key held in the environment
 *     (`VAULT_KEK`, base64) — or a secrets manager in production. Never
 *     persisted to the database.
 *   - DEK (Data Encryption Key): one 32-byte key per organization, generated
 *     at first use and stored only in KEK-wrapped form (in `vault_keys`).
 *
 * Ciphertext format (sealed blobs are base64): nonce(12) || authTag(16) ||
 * ciphertext. A fresh random nonce is used for every seal, and GCM's auth
 * tag makes any tampering with a stored blob fail loudly on open.
 *
 * All primitives come from node:crypto — no hand-rolled algorithms.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Generate a fresh 32-byte key (used for KEK dev fallback and org DEKs). */
export function generateKey() {
  return randomBytes(KEY_BYTES);
}

/**
 * Seal `plaintext` under `key`. Returns a base64 blob of
 * nonce || authTag || ciphertext. Never reuse a key+nonce pair; every call
 * draws a fresh random nonce, which is what makes this safe.
 */
export function seal(key, plaintext) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError(`seal requires a ${KEY_BYTES}-byte key buffer`);
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]).toString('base64');
}

/**
 * Open a blob produced by `seal`. Throws if the key is wrong or the blob was
 * tampered with (GCM authentication failure).
 */
export function open(key, sealedBase64) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError(`open requires a ${KEY_BYTES}-byte key buffer`);
  }
  const buf = Buffer.from(sealedBase64, 'base64');
  if (buf.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error('Ciphertext blob is truncated.');
  }
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Resolve the environment KEK.
 *
 * - `VAULT_KEK` set → must decode to exactly 32 bytes.
 * - unset, non-production → a fresh ephemeral key (dev convenience; wrapped
 *   keys become unrecoverable after restart — acceptable in dev only).
 * - unset, production → hard failure. A vault that silently degrades to an
 *   ephemeral key in production would lock every customer's LLM keys out on
 *   the next deploy; refusing to boot is the safe failure mode.
 */
export function loadKek(env = process.env) {
  if (env.VAULT_KEK) {
    const kek = Buffer.from(env.VAULT_KEK, 'base64');
    if (kek.length !== KEY_BYTES) {
      throw new Error(`VAULT_KEK must be ${KEY_BYTES} base64-encoded bytes (got ${kek.length}).`);
    }
    return kek;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('VAULT_KEK is required in production: set a 32-byte base64 key via the secrets manager.');
  }
  return generateKey();
}

/**
 * Derive the display preview of a secret for masked output, e.g.
 * `sk-proj-abc…9f2c`. The full secret never leaves the service layer.
 */
export function maskKey(apiKey) {
  const s = String(apiKey);
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
