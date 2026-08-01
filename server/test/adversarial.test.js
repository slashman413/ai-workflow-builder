/**
 * adversarial.test.js — Automated Adversarial Cross-Tenant Test Suite (Increment 2)
 *
 * This test suite subjects the zero-trust middleware, multi-tenant DB enforcement,
 * and envelope-encrypted Secrets Vault to systematic adversarial attack simulations.
 *
 * It validates four primary attack surfaces across all guarded endpoints:
 *   1. Unauthorized JWT Access: missing Bearer token, forged/invalid token signature,
 *      or token with missing org_id claim (asserting 401 UNAUTHENTICATED / 403 ORG_REQUIRED).
 *   2. RBAC Privilege Escalation: Viewer attempting Architect/Owner write endpoints,
 *      Architect attempting Owner delete endpoints (asserting 403 FORBIDDEN).
 *   3. Cross-Tenant Resource Reads/Writes: Org B attempting to read, alter, or delete
 *      Org A's projects, grill sessions, workflow DAGs, or vault entries (asserting 404/403
 *      to prevent resource enumeration and unauthorized mutation).
 *   4. Vault Key Exfiltration & Endpoint Probing: asserting plaintext API keys and wrapped
 *      KEK/DEK material are NEVER returned in any HTTP response or exposed via unmapped
 *      decryption endpoints.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { generateKey } from '../src/domain/vault/crypto.js';
import { createApp } from '../src/adapters/http/app.js';

const KEK = generateKey();
const SECRET_API_KEY = 'sk-proj-ADVERSARIAL_EXFILTRATION_TEST_KEY_889900';
const json = (r) => r.json();
const bearer = (token = 'valid.session.token') => ({ authorization: `Bearer ${token}` });

/** Stub Clerk client that emulates token verification and org claim resolution. */
function stubClerk({ status = 'signed-in', claims = {} } = {}) {
  return {
    authenticateRequest: async ({ headerToken }) => {
      if (!headerToken || headerToken === 'forged.token.attempt' || headerToken === 'invalid-jwt') {
        return { status: 'signed-out', headers: {}, claims: null };
      }
      if (status !== 'signed-in') return { status, headers: {}, claims: null };
      const base = { sub: 'user_attacker', org_id: 'org_b', org_role: 'org:owner' };
      return { status: 'signed-in', headers: {}, claims: { ...base, ...claims } };
    },
  };
}

const claimsFor = (orgId, orgRole, userId = 'user_123') =>
  stubClerk({ claims: { sub: userId, org_id: orgId, org_role: orgRole } });

/** Spin up test server with a configured Clerk stub. */
async function withClerkApp(clerkClient) {
  const app = createApp(createMemoryRepos(), { auth: { mode: 'clerk', clerkClient }, kek: KEK });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${srv.address().port}/api`,
    close: () => srv.close(),
  };
}

/** All secured endpoints across projects, grill, workflow builder, and vault. */
function getGuardedEndpoints(projectId = 'p_test', vaultId = 'v_test') {
  return [
    { method: 'GET', path: '/projects', role: 'viewer' },
    { method: 'POST', path: '/projects', role: 'architect', body: { prompt: 'test' } },
    { method: 'GET', path: `/projects/${projectId}`, role: 'viewer' },
    { method: 'DELETE', path: `/projects/${projectId}`, role: 'owner' },
    { method: 'GET', path: `/projects/${projectId}/grill`, role: 'viewer' },
    { method: 'POST', path: `/projects/${projectId}/answers`, role: 'architect', body: { answers: {} } },
    { method: 'POST', path: `/projects/${projectId}/workflow/scaffold`, role: 'architect', body: { force: false } },
    { method: 'PUT', path: `/projects/${projectId}/workflow`, role: 'architect', body: { workflow: {} } },
    { method: 'GET', path: `/projects/${projectId}/workflow`, role: 'viewer' },
    { method: 'GET', path: '/vault', role: 'architect' },
    { method: 'POST', path: '/vault', role: 'architect', body: { provider: 'openai', apiKey: SECRET_API_KEY } },
    { method: 'GET', path: `/vault/${vaultId}`, role: 'architect' },
    { method: 'DELETE', path: `/vault/${vaultId}`, role: 'owner' },
  ];
}

test('1. Unauthorized JWT Access — missing token returns 401 UNAUTHENTICATED across all endpoints', async () => {
  const srv = await withClerkApp(claimsFor('org_a', 'org:owner'));
  try {
    for (const ep of getGuardedEndpoints()) {
      const opts = {
        method: ep.method,
        headers: { 'content-type': 'application/json' },
      };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      const res = await fetch(`${srv.base}${ep.path}`, opts);
      assert.equal(res.status, 401, `Expected 401 for ${ep.method} ${ep.path} without JWT`);
      const body = await json(res);
      assert.equal(body.error, 'UNAUTHENTICATED');
    }
  } finally {
    srv.close();
  }
});

test('1. Unauthorized JWT Access — forged/invalid JWT returns 401 UNAUTHENTICATED across all endpoints', async () => {
  const srv = await withClerkApp(claimsFor('org_a', 'org:owner'));
  try {
    for (const ep of getGuardedEndpoints()) {
      const opts = {
        method: ep.method,
        headers: { 'content-type': 'application/json', ...bearer('forged.token.attempt') },
      };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      const res = await fetch(`${srv.base}${ep.path}`, opts);
      assert.equal(res.status, 401, `Expected 401 for forged token on ${ep.method} ${ep.path}`);
      const body = await json(res);
      assert.equal(body.error, 'UNAUTHENTICATED');
    }
  } finally {
    srv.close();
  }
});

test('1. Unauthorized JWT Access — signed-in session missing org_id returns 403 ORG_REQUIRED', async () => {
  const srv = await withClerkApp(stubClerk({ claims: { sub: 'user_no_org', org_id: null, org_role: 'org:owner' } }));
  try {
    for (const ep of getGuardedEndpoints()) {
      const opts = {
        method: ep.method,
        headers: { 'content-type': 'application/json', ...bearer('valid.session.token') },
      };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      const res = await fetch(`${srv.base}${ep.path}`, opts);
      assert.equal(res.status, 403, `Expected 403 ORG_REQUIRED for ${ep.method} ${ep.path}`);
      const body = await json(res);
      assert.equal(body.error, 'ORG_REQUIRED');
    }
  } finally {
    srv.close();
  }
});

test('2. RBAC Privilege Escalation — Viewer attempting Architect/Owner operations gets 403 FORBIDDEN', async () => {
  const srv = await withClerkApp(claimsFor('org_a', 'org:viewer'));
  try {
    const endpoints = getGuardedEndpoints().filter((ep) => ep.role === 'architect' || ep.role === 'owner');
    for (const ep of endpoints) {
      const opts = {
        method: ep.method,
        headers: { 'content-type': 'application/json', ...bearer() },
      };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      const res = await fetch(`${srv.base}${ep.path}`, opts);
      assert.equal(res.status, 403, `Expected 403 FORBIDDEN for Viewer on ${ep.method} ${ep.path}`);
      const body = await json(res);
      assert.equal(body.error, 'FORBIDDEN');
    }
  } finally {
    srv.close();
  }
});

test('2. RBAC Privilege Escalation — Architect attempting Owner delete operations gets 403 FORBIDDEN', async () => {
  const srv = await withClerkApp(claimsFor('org_a', 'org:architect'));
  try {
    const endpoints = getGuardedEndpoints().filter((ep) => ep.role === 'owner');
    for (const ep of endpoints) {
      const opts = {
        method: ep.method,
        headers: { 'content-type': 'application/json', ...bearer() },
      };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      const res = await fetch(`${srv.base}${ep.path}`, opts);
      assert.equal(res.status, 403, `Expected 403 FORBIDDEN for Architect on ${ep.method} ${ep.path}`);
      const body = await json(res);
      assert.equal(body.error, 'FORBIDDEN');
    }
  } finally {
    srv.close();
  }
});

test('3. Cross-Tenant Resource Reads/Writes — Org B cannot read or modify any Org A resource (404 Not Found)', async () => {
  // Setup a shared repository underlying two apps with different tenant JWTs
  const repos = createMemoryRepos();
  const appA = createApp(repos, { auth: { mode: 'clerk', clerkClient: claimsFor('org_a', 'org:owner') }, kek: KEK });
  const appB = createApp(repos, { auth: { mode: 'clerk', clerkClient: claimsFor('org_b', 'org:owner') }, kek: KEK });

  const srvA = await new Promise((r) => {
    const s = appA.listen(0, () => r({ base: `http://127.0.0.1:${s.address().port}/api`, close: () => s.close() }));
  });
  const srvB = await new Promise((r) => {
    const s = appB.listen(0, () => r({ base: `http://127.0.0.1:${s.address().port}/api`, close: () => s.close() }));
  });

  try {
    // Org A seeds resources: project, grill answer, workflow, and vault key
    const pRes = await fetch(`${srvA.base}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer() },
      body: JSON.stringify({ prompt: 'Org A confidental strategy' }),
    });
    const projA = await json(pRes);

    await fetch(`${srvA.base}/projects/${projA.id}/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer() },
      body: JSON.stringify({ answers: { 'goal.outcome': 'Secret outcome' } }),
    });
    await fetch(`${srvA.base}/projects/${projA.id}/workflow/scaffold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer() },
      body: JSON.stringify({}),
    });

    const vRes = await fetch(`${srvA.base}/vault`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer() },
      body: JSON.stringify({ provider: 'openai', label: 'org-a-key', apiKey: SECRET_API_KEY }),
    });
    const vaultA = await json(vRes);

    // Org B attacks: attempts to access Org A's project and vault key IDs
    const attackEndpoints = [
      { method: 'GET', path: `/projects/${projA.id}` },
      { method: 'GET', path: `/projects/${projA.id}/grill` },
      { method: 'GET', path: `/projects/${projA.id}/workflow` },
      { method: 'POST', path: `/projects/${projA.id}/answers`, body: { answers: { 'goal.outcome': 'hijacked by org_b' } } },
      { method: 'POST', path: `/projects/${projA.id}/workflow/scaffold`, body: { force: true } },
      { method: 'PUT', path: `/projects/${projA.id}/workflow`, body: { workflow: { id: 'stolen', nodes: [] } } },
      { method: 'DELETE', path: `/projects/${projA.id}/` },
      { method: 'GET', path: `/vault/${vaultA.id}` },
      { method: 'DELETE', path: `/vault/${vaultA.id}` },
    ];

    for (const ep of attackEndpoints) {
      const opts = {
        method: ep.method,
        headers: { 'content-type': 'application/json', ...bearer() },
      };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      const res = await fetch(`${srvB.base}${ep.path}`, opts);
      assert.equal(res.status, 404, `Org B cross-tenant attack on ${ep.method} ${ep.path} must return 404 to prevent resource enumeration`);
    }

    // Assert Org A's data was completely untouched by Org B's write/delete attempts
    const checkA = await json(await fetch(`${srvA.base}/projects/${projA.id}`, { headers: bearer() }));
    assert.equal(checkA.prompt, 'Org A confidental strategy');
    const checkVault = await json(await fetch(`${srvA.base}/vault/${vaultA.id}`, { headers: bearer() }));
    assert.equal(checkVault.label, 'org-a-key');
  } finally {
    srvA.close();
    srvB.close();
  }
});

test('4. Vault Key Exfiltration — plaintext API keys and encryption material are NEVER returned in API responses', async () => {
  const srv = await withClerkApp(claimsFor('org_vault', 'org:owner'));
  try {
    const storeRes = await fetch(`${srv.base}/vault`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer() },
      body: JSON.stringify({ provider: 'openai', label: 'prod-ai', apiKey: SECRET_API_KEY }),
    });
    assert.equal(storeRes.status, 201);
    const stored = await json(storeRes);

    const listRes = await fetch(`${srv.base}/vault`, { headers: bearer() });
    const listed = await json(listRes);

    const getRes = await fetch(`${srv.base}/vault/${stored.id}`, { headers: bearer() });
    const fetched = await json(getRes);

    // Verify all responses for leakage of plaintext key or wrapping keys
    for (const data of [stored, listed, fetched]) {
      const serialized = JSON.stringify(data);
      assert.ok(!serialized.includes(SECRET_API_KEY), 'Plaintext secret API key leaked in response body!');
      assert.ok(!serialized.includes('ADVERSARIAL'), 'Partial API key substring leaked!');
      assert.ok(!serialized.includes('wrappedKey'), 'wrappedKey attribute leaked in public API response!');
      assert.ok(!serialized.includes('wrappedDek'), 'wrappedDek attribute leaked in public API response!');
      assert.ok(!serialized.includes('kek'), 'KEK reference leaked in public API response!');
    }

    // Probing attack: attempt to reach unauthorized internal decryption/reveal routes or parameter injections
    const probes = [
      `/vault/${stored.id}/key`,
      `/vault/${stored.id}/reveal`,
      `/vault/${stored.id}/plaintext`,
      `/vault/${stored.id}?reveal=true`,
      `/vault/${stored.id}?decrypt=true`,
      `/vault/reveal/${stored.keyHandle}`,
    ];

    for (const path of probes) {
      const probeRes = await fetch(`${srv.base}${path}`, { headers: bearer() });
      if (probeRes.status === 200) {
        const body = await json(probeRes);
        const serialized = JSON.stringify(body);
        assert.ok(!serialized.includes(SECRET_API_KEY), `Exfiltration probe on ${path} succeeded in leaking plaintext key!`);
      } else {
        assert.ok(probeRes.status === 404 || probeRes.status === 400 || probeRes.status === 403, `Probe returned unexpected status ${probeRes.status} on ${path}`);
      }
    }
  } finally {
    srv.close();
  }
});
