/**
 * vaultService.js — envelope-encrypted LLM provider key vault.
 *
 * Responsibilities:
 *   - store provider keys (OpenAI / Anthropic / Gemini) under a per-org DEK
 *     wrapped by the environment KEK (AES-256-GCM, see domain/vault/crypto.js),
 *   - serve read models that contain ONLY masked labels and metadata,
 *   - reveal plaintext exclusively through the internal `revealKey` method,
 *     which is deliberately NOT wired to any HTTP route.
 *
 * The vault repository stores opaque blobs; this service owns all key
 * material and all cryptography. Nothing key-shaped ever crosses the HTTP
 * adapter except the masked preview.
 */

import { randomUUID } from 'node:crypto';
import { AppError, assertOrg } from './errors.js';
import * as vaultCrypto from '../domain/vault/crypto.js';

/** Providers the vault will accept, mapped to a human-readable default label. */
export const PROVIDERS = Object.freeze({
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
});

const MAX_KEY_LENGTH = 2048; // API keys are short; anything longer is not a key.

export class VaultService {
  /**
   * @param {{ vaultKeys: any }} repos The vault repository port.
   * @param {object} [opts]
   * @param {Buffer} [opts.kek] Environment Key Encryption Key (32 bytes). If
   *   omitted, resolved from the environment via loadKek() — ephemeral in
   *   dev, required in production.
   */
  constructor({ vaultKeys }, { kek = vaultCrypto.loadKek() } = {}) {
    this.vaultKeys = vaultKeys;
    this.kek = kek;
  }

  /**
   * Store a provider API key for an organization. Returns masked metadata —
   * the plaintext never appears in the return value.
   */
  store(orgId, { provider, label, apiKey } = {}) {
    assertOrg(orgId);

    if (!provider || !(provider in PROVIDERS)) {
      throw new AppError('INVALID_PROVIDER', `provider must be one of: ${Object.keys(PROVIDERS).join(', ')}.`);
    }
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.trim().length > MAX_KEY_LENGTH) {
      throw new AppError('INVALID_API_KEY', `apiKey must be a non-empty string up to ${MAX_KEY_LENGTH} chars.`);
    }
    const cleanKey = apiKey.trim();
    const cleanLabel = (typeof label === 'string' && label.trim() ? label.trim() : PROVIDERS[provider]).slice(0, 80);

    // One DEK per organization. Reuse the org's existing DEK when one exists
    // (unwrap it with the KEK), otherwise mint a fresh DEK.
    const existing = this.vaultKeys.listByOrg(orgId)[0];
    const dek = existing ? Buffer.from(vaultCrypto.open(this.kek, existing.wrappedDek), 'base64') : vaultCrypto.generateKey();
    const wrappedDek = vaultCrypto.seal(this.kek, dek.toString('base64'));

    const record = {
      id: `vk_${randomUUID()}`,
      orgId,
      provider,
      label: cleanLabel,
      keyHandle: `kh_${randomUUID()}`,
      maskedKey: vaultCrypto.maskKey(cleanKey),
      wrappedDek,
      wrappedKey: vaultCrypto.seal(dek, cleanKey),
    };
    this.vaultKeys.insert(record);
    return this.toPublic(record);
  }

  /** List the org's vault entries — masked labels and metadata only. */
  list(orgId) {
    assertOrg(orgId);
    return this.vaultKeys.listByOrg(orgId).map(this.toPublic);
  }

  /** Fetch one entry by id, scoped to the org. 404 if it is not theirs. */
  get(orgId, id) {
    assertOrg(orgId);
    const record = this.vaultKeys.getByOrg(orgId, id);
    if (!record) throw new AppError('NOT_FOUND', `Vault entry ${id} not found.`, 404);
    return this.toPublic(record);
  }

  /** Delete an entry. 404 if it does not exist in this org. */
  remove(orgId, id) {
    assertOrg(orgId);
    const ok = this.vaultKeys.removeByOrg(orgId, id);
    if (!ok) throw new AppError('NOT_FOUND', `Vault entry ${id} not found.`, 404);
    return { deleted: true, id };
  }

  /**
   * INTERNAL USE ONLY — decrypt and return the plaintext provider key.
   *
   * This is the method the workflow executor will call when it needs to
   * authenticate to a provider. It must NEVER be wired to an HTTP route:
   * doing so would turn the vault into a key-export endpoint. The
   * adversarial test suite asserts no route exposes it.
   */
  revealKey(orgId, keyHandle) {
    assertOrg(orgId);
    const record = this.vaultKeys.getByKeyHandle(orgId, keyHandle);
    if (!record) throw new AppError('NOT_FOUND', `Vault entry ${keyHandle} not found.`, 404);
    const dek = Buffer.from(vaultCrypto.open(this.kek, record.wrappedDek), 'base64');
    return { provider: record.provider, apiKey: vaultCrypto.open(dek, record.wrappedKey) };
  }

  /** Strip everything sensitive — the only shape that may leave this service. */
  toPublic(record) {
    return {
      id: record.id,
      provider: record.provider,
      label: record.label,
      keyHandle: record.keyHandle,
      maskedKey: record.maskedKey,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
