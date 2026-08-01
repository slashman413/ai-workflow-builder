/**
 * vault.test.js — envelope encryption and the VaultService.
 *
 * Proves the cryptographic contract:
 *   - AES-256-GCM seal/open round-trips; tampering fails loudly,
 *   - a per-org DEK is wrapped by the environment KEK (two independent key
 *     layers — losing the KEK loses every key, exfiltrating the DB alone
 *     recovers nothing),
 *   - one DEK per org is reused across entries,
 *   - the public read model contains masked labels ONLY — no plaintext, no
 *     wrapped material,
 *   - revealKey() (internal) decrypts for the owning org and refuses others,
 *   - KEK policy: production refuses to boot without VAULT_KEK; a malformed
 *     VAULT_KEK is rejected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultService } from '../src/application/vaultService.js';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { generateKey, seal, open, loadKek, maskKey } from '../src/domain/vault/crypto.js';

const KEK = generateKey();
const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789-ABCD';
const GEMINI_KEY = 'AIzaSyDummyGeminiKeyForTestingPurposes123456';

function vault(repos = createMemoryRepos()) {
  return new VaultService(repos, { kek: KEK });
}

// --- crypto primitives -------------------------------------------------------

test('seal/open round-trips under the same key', () => {
  const blob = seal(KEK, OPENAI_KEY);
  assert.equal(open(KEK, blob), OPENAI_KEY);
  assert.notEqual(blob, Buffer.from(OPENAI_KEY).toString('base64'), 'ciphertext must not equal plaintext encoding');
});

test('every seal draws a fresh nonce — same plaintext, different blobs', () => {
  const a = seal(KEK, OPENAI_KEY);
  const b = seal(KEK, OPENAI_KEY);
  assert.notEqual(a, b);
});

test('tampering with a sealed blob fails loudly (GCM auth tag)', () => {
  const blob = Buffer.from(seal(KEK, OPENAI_KEY), 'base64');
  blob[blob.length - 1] ^= 0x01; // flip one ciphertext bit
  assert.throws(() => open(KEK, blob.toString('base64')), /auth|unable|fail/i);
});

test('wrong key cannot open a blob', () => {
  const blob = seal(KEK, OPENAI_KEY);
  assert.throws(() => open(generateKey(), blob));
});

test('maskKey hides everything but the head and tail', () => {
  const masked = maskKey(OPENAI_KEY);
  assert.ok(masked.startsWith(OPENAI_KEY.slice(0, 4)));
  assert.ok(masked.endsWith(OPENAI_KEY.slice(-4)));
  assert.ok(!masked.includes(OPENAI_KEY.slice(4, -4)));
  assert.equal(maskKey('short'), '••••');
});

// --- KEK policy --------------------------------------------------------------

test('loadKek rejects a malformed VAULT_KEK', () => {
  const prev = process.env.VAULT_KEK;
  process.env.VAULT_KEK = 'not-base64-key-material';
  try {
    assert.throws(() => loadKek(), /32 base64-encoded bytes/);
  } finally {
    if (prev === undefined) delete process.env.VAULT_KEK;
    else process.env.VAULT_KEK = prev;
  }
});

test('loadKek refuses to run production without VAULT_KEK', () => {
  const prevKek = process.env.VAULT_KEK;
  const prevEnv = process.env.NODE_ENV;
  delete process.env.VAULT_KEK;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => loadKek(), /VAULT_KEK is required in production/);
  } finally {
    if (prevKek === undefined) delete process.env.VAULT_KEK;
    else process.env.VAULT_KEK = prevKek;
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  }
});

// --- service behavior --------------------------------------------------------

test('store returns masked metadata only — plaintext never leaves the service', () => {
  const s = vault();
  const entry = s.store('org_a', { provider: 'openai', label: 'prod', apiKey: OPENAI_KEY });

  assert.equal(entry.provider, 'openai');
  assert.equal(entry.label, 'prod');
  assert.equal(entry.maskedKey, maskKey(OPENAI_KEY));
  assert.ok(entry.id.startsWith('vk_'));
  assert.ok(entry.keyHandle.startsWith('kh_'));
  assert.ok(!JSON.stringify(entry).includes(OPENAI_KEY), 'no plaintext in the public shape');
  assert.ok(!('wrappedKey' in entry) && !('wrappedDek' in entry), 'wrapped material never exposed');
});

test('list and get return masked entries only, no plaintext or wrapped material', () => {
  const repos = createMemoryRepos();
  const s = vault(repos);
  s.store('org_a', { provider: 'openai', apiKey: OPENAI_KEY });
  s.store('org_a', { provider: 'gemini', apiKey: GEMINI_KEY });

  const list = s.list('org_a');
  assert.equal(list.length, 2);
  const serialized = JSON.stringify(list);
  assert.ok(!serialized.includes(OPENAI_KEY) && !serialized.includes(GEMINI_KEY));
  assert.ok(!serialized.includes('wrapped') && !serialized.includes('dek') && !serialized.includes('ciphertext'));

  const one = s.get('org_a', list[0].id);
  assert.equal(one.id, list[0].id);
  assert.ok(!JSON.stringify(one).includes(OPENAI_KEY));
});

test('one DEK per org is reused; different orgs get different DEKs', () => {
  const repos = createMemoryRepos();
  const s = vault(repos);
  s.store('org_a', { provider: 'openai', apiKey: OPENAI_KEY });
  s.store('org_a', { provider: 'anthropic', apiKey: 'sk-ant-dummy-123' });

  const rows = repos.vaultKeys.listByOrg('org_a');
  assert.equal(rows.length, 2);
  // Same org → same wrapped DEK (same key, fresh nonce each wrap — equal
  // plaintext, so unwrapping both yields the identical DEK).
  const dekA = Buffer.from(open(KEK, rows[0].wrappedDek), 'base64');
  const dekB = Buffer.from(open(KEK, rows[1].wrappedDek), 'base64');
  assert.deepEqual(dekA, dekB, 'org_a reuses one DEK across entries');

  // Cross-org: keys decrypt independently and are not interchangeable.
  s.store('org_b', { provider: 'openai', apiKey: 'sk-org-b-key' });
  const bRow = repos.vaultKeys.listByOrg('org_b')[0];
  const dekB2 = Buffer.from(open(KEK, bRow.wrappedDek), 'base64');
  assert.notDeepEqual(dekA, dekB2, 'org_b has its own DEK');
});

test('revealKey decrypts the exact plaintext for the owning org (internal use)', () => {
  const repos = createMemoryRepos();
  const s = vault(repos);
  const entry = s.store('org_a', { provider: 'gemini', label: 'prod', apiKey: GEMINI_KEY });
  const revealed = s.revealKey('org_a', entry.keyHandle);
  assert.equal(revealed.provider, 'gemini');
  assert.equal(revealed.apiKey, GEMINI_KEY);

  // A different org cannot reveal it (404 — indistinguishable from missing).
  assert.throws(() => s.revealKey('org_b', entry.keyHandle), (e) => e.status === 404);
});

test('cross-org get/remove → 404/false, org data untouched', () => {
  const repos = createMemoryRepos();
  const s = vault(repos);
  const entry = s.store('org_a', { provider: 'openai', apiKey: OPENAI_KEY });

  assert.throws(() => s.get('org_b', entry.id), (e) => e.status === 404);
  assert.throws(() => s.remove('org_b', entry.id), (e) => e.status === 404);
  assert.equal(s.list('org_b').length, 0);
  assert.equal(s.list('org_a').length, 1, 'org_a entry survives the attack');
});

test('validation: unknown provider and empty key are rejected', () => {
  const s = vault();
  assert.throws(() => s.store('org_a', { provider: 'claude', apiKey: 'x' }), (e) => e.code === 'INVALID_PROVIDER');
  assert.throws(() => s.store('org_a', { provider: 'openai', apiKey: '   ' }), (e) => e.code === 'INVALID_API_KEY');
  assert.throws(() => s.store('org_a', { provider: 'openai' }), (e) => e.code === 'INVALID_API_KEY');
  assert.throws(() => s.store('', { provider: 'openai', apiKey: 'x' }), (e) => e.code === 'ORG_REQUIRED');
});

test('label defaults to the provider name and is truncated to 80 chars', () => {
  const s = vault();
  const defaulted = s.store('org_a', { provider: 'anthropic', apiKey: 'sk-ant-x' });
  assert.equal(defaulted.label, 'Anthropic');
  const long = s.store('org_a', { provider: 'openai', apiKey: 'sk-x', label: 'x'.repeat(200) });
  assert.equal(long.label.length, 80);
});
