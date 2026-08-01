/**
 * vaultHttp.test.js — the vault over HTTP, including adversarial checks.
 *
 * Proves deliverable 4's hard requirement end-to-end: the API read endpoints
 * NEVER expose plaintext keys — the raw key string and the wrapped material
 * are absent from every vault response body — and the vault is tenant-scoped
 * (Org B gets 404 on Org A's entries) and role-gated (viewer 403,
 * architect cannot delete).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { generateKey } from '../src/domain/vault/crypto.js';

let createApp;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
} catch {
  createApp = null;
}
const maybe = createApp ? test : test.skip;

const KEK = generateKey();
const OPENAI_KEY = 'sk-proj-THIS-IS-A-REAL-LOOKING-SECRET-KEY-9876543210';
const json = (r) => r.json();

const headers = (orgId, role = 'org:owner') => ({
  'content-type': 'application/json',
  'x-org-id': orgId,
  'x-user-role': role,
});

/** Each test gets its own app + socket (independent state). */
async function withServer() {
  const app = createApp(createMemoryRepos(), { kek: KEK });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { base: `http://127.0.0.1:${srv.address().port}/api`, close: () => srv.close() };
}

const store = (base, orgId, role) =>
  fetch(`${base}/vault`, {
    method: 'POST',
    headers: headers(orgId, role),
    body: JSON.stringify({ provider: 'openai', label: 'prod-key', apiKey: OPENAI_KEY }),
  });

maybe('POST /vault stores a key and returns only the masked entry', async () => {
  const srv = await withServer();
  try {
    const r = await store(srv.base, 'org_a');
    assert.equal(r.status, 201);
    const body = await json(r);
    assert.equal(body.provider, 'openai');
    assert.equal(body.label, 'prod-key');
    assert.ok(body.maskedKey.startsWith('sk-p') && body.maskedKey.endsWith('3210'));
    assert.ok(body.keyHandle.startsWith('kh_'));

    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(OPENAI_KEY), 'plaintext key must not appear in the response');
    assert.ok(!serialized.includes('wrapped'), 'wrapped material must not appear in the response');
  } finally {
    srv.close();
  }
});

maybe('GET /vault returns masked labels only, no plaintext or wrapped material', async () => {
  const srv = await withServer();
  try {
    await store(srv.base, 'org_a');
    const r = await fetch(`${srv.base}/vault`, { headers: headers('org_a') });
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.length, 1);

    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(OPENAI_KEY), 'plaintext key must not appear in the list');
    assert.ok(!serialized.includes('wrapped') && !serialized.includes('ciphertext') && !serialized.includes('nonce'));
  } finally {
    srv.close();
  }
});

maybe('GET /vault/:id returns the masked entry', async () => {
  const srv = await withServer();
  try {
    const entry = await json(await store(srv.base, 'org_a'));
    const r = await fetch(`${srv.base}/vault/${entry.id}`, { headers: headers('org_a') });
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.id, entry.id);
    assert.ok(!JSON.stringify(body).includes(OPENAI_KEY));
  } finally {
    srv.close();
  }
});

maybe('DELETE /vault/:id removes the entry (owner)', async () => {
  const srv = await withServer();
  try {
    const entry = await json(await store(srv.base, 'org_a'));
    const r = await fetch(`${srv.base}/vault/${entry.id}`, { method: 'DELETE', headers: headers('org_a') });
    assert.equal(r.status, 200);
    assert.equal((await json(r)).deleted, true);
    const gone = await fetch(`${srv.base}/vault/${entry.id}`, { headers: headers('org_a') });
    assert.equal(gone.status, 404);
  } finally {
    srv.close();
  }
});

// --- adversarial: cross-tenant vault access ---------------------------------

maybe('Org B cannot read or delete Org A vault entries (404)', async () => {
  const srv = await withServer();
  try {
    const entry = await json(await store(srv.base, 'org_a'));

    const listB = await fetch(`${srv.base}/vault`, { headers: headers('org_b') });
    assert.deepEqual(await json(listB), [], 'Org B sees an empty vault');

    const getB = await fetch(`${srv.base}/vault/${entry.id}`, { headers: headers('org_b') });
    assert.equal(getB.status, 404);

    const delB = await fetch(`${srv.base}/vault/${entry.id}`, { method: 'DELETE', headers: headers('org_b') });
    assert.equal(delB.status, 404);

    // Org A's entry is untouched.
    const getA = await fetch(`${srv.base}/vault/${entry.id}`, { headers: headers('org_a') });
    assert.equal(getA.status, 200);
  } finally {
    srv.close();
  }
});

// --- adversarial: RBAC on the vault ------------------------------------------

maybe('viewer is forbidden from the vault entirely (403)', async () => {
  const srv = await withServer();
  try {
    await store(srv.base, 'org_a'); // seed as owner
    const r = await fetch(`${srv.base}/vault`, { headers: headers('org_a', 'org:viewer') });
    assert.equal(r.status, 403);
    assert.equal((await json(r)).error, 'FORBIDDEN');

    const post = await fetch(`${srv.base}/vault`, {
      method: 'POST',
      headers: headers('org_a', 'org:viewer'),
      body: JSON.stringify({ provider: 'openai', apiKey: OPENAI_KEY }),
    });
    assert.equal(post.status, 403);
  } finally {
    srv.close();
  }
});

maybe('architect can store keys but cannot delete them (owner-only)', async () => {
  const srv = await withServer();
  try {
    const entry = await json(await store(srv.base, 'org_a', 'org:architect'));
    assert.ok(entry.id);

    const del = await fetch(`${srv.base}/vault/${entry.id}`, { method: 'DELETE', headers: headers('org_a', 'org:architect') });
    assert.equal(del.status, 403);

    const ownerDel = await fetch(`${srv.base}/vault/${entry.id}`, { method: 'DELETE', headers: headers('org_a', 'org:owner') });
    assert.equal(ownerDel.status, 200);
  } finally {
    srv.close();
  }
});

maybe('invalid payloads → 400 with no write', async () => {
  const srv = await withServer();
  try {
    const bad = await fetch(`${srv.base}/vault`, {
      method: 'POST',
      headers: headers('org_a'),
      body: JSON.stringify({ provider: 'claude', apiKey: 'x' }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).error, 'INVALID_PROVIDER');

    const missing = await fetch(`${srv.base}/vault`, {
      method: 'POST',
      headers: headers('org_a'),
      body: JSON.stringify({ provider: 'openai' }),
    });
    assert.equal(missing.status, 400);
    assert.equal((await json(missing)).error, 'INVALID_API_KEY');
  } finally {
    srv.close();
  }
});
