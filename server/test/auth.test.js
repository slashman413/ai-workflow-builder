/**
 * auth.test.js — the backend authorization choke point.
 *
 * Two things are under test:
 *  1. The `requireOrg` middleware in Clerk mode: token extraction, JWT
 *     verification (via an injected stub client — the real client talks to
 *     Clerk's API, which never happens in CI), org_id claim binding, and
 *     the authenticated-but-org-less 403.
 *  2. The RBAC gate: Owner (3) > Architect (2) > Viewer (1), mapped from
 *     Clerk's `org_role` claim. Unknown roles fail closed.
 *
 * All requests go through the real Express app over a live socket, so this
 * also proves the choke point is actually wired onto the secured routes.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { generateKey } from '../src/domain/vault/crypto.js';

let createApp;
let resolveAuthMode;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
  ({ resolveAuthMode } = await import('../src/adapters/http/auth.js'));
} catch {
  createApp = null;
}
const maybe = createApp ? test : test.skip;

const KEK = generateKey();
const json = (r) => r.json();

/** A stub Clerk backend client that never touches the network. */
function stubClerk({ status = 'signed-in', claims = {} } = {}) {
  return {
    authenticateRequest: async ({ headerToken }) => {
      if (!headerToken || headerToken === 'bogus') {
        return { status: 'signed-out', headers: {}, claims: null };
      }
      if (status !== 'signed-in') return { status, headers: {}, claims: null };
      // Default claims mirror a real org session token; callers override.
      const base = { sub: 'user_123', org_id: 'org_clerk', org_role: 'org:admin' };
      return { status: 'signed-in', headers: {}, claims: { ...base, ...claims } };
    },
  };
}

const claimsFor = (orgId, orgRole) => stubClerk({ claims: { sub: 'user_123', org_id: orgId, org_role: orgRole } });
const bearer = (token = 'valid.session.token') => ({ authorization: `Bearer ${token}` });

let server;
let base;
let clerkApp;

before(async () => {
  if (!createApp) return;
  // A Clerk-mode app with a stubbed client.
  clerkApp = createApp(createMemoryRepos(), { auth: { mode: 'clerk', clerkClient: stubClerk() }, kek: KEK });
  await new Promise((resolve) => {
    server = clerkApp.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
});

after(() => server?.close());

maybe('missing bearer token → 401 UNAUTHENTICATED', async () => {
  const r = await fetch(`${base}/projects`, { headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 401);
  assert.equal((await json(r)).error, 'UNAUTHENTICATED');
});

maybe('invalid token → 401 (verification failure, not 500)', async () => {
  const r = await fetch(`${base}/projects`, { headers: { 'content-type': 'application/json', ...bearer('bogus') } });
  assert.equal(r.status, 401);
  assert.equal((await json(r)).error, 'UNAUTHENTICATED');
});

maybe('signed-in session binds org_id from the JWT claim', async () => {
  const r = await fetch(`${base}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer() },
    body: JSON.stringify({ prompt: 'summarise my emails' }),
  });
  assert.equal(r.status, 201);
  const created = await json(r);

  // The project is listed under the claim's org…
  const listed = await json(await fetch(`${base}/projects`, { headers: bearer() }));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  // …and a DIFFERENT org's token cannot see it (cross-tenant 404).
  const other = await withApp(claimsFor('org_other', 'org:admin'));
  try {
    const r2 = await fetch(`${other.base}/projects/${created.id}`, { headers: bearer() });
    assert.equal(r2.status, 404);
    const r3 = await fetch(`${other.base}/projects`, { headers: bearer() });
    assert.deepEqual(await json(r3), []);
  } finally {
    other.close();
  }
});

maybe('signed-in session WITHOUT org_id → 403 ORG_REQUIRED', async () => {
  const noOrg = await withApp(stubClerk({ claims: { org_id: null } }));
  try {
    const r = await fetch(`${noOrg.base}/projects`, { headers: bearer() });
    assert.equal(r.status, 403);
    assert.equal((await json(r)).error, 'ORG_REQUIRED');
  } finally {
    noOrg.close();
  }
});

maybe('health probe stays public in Clerk mode', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.equal((await json(r)).status, 'ok');
});

// --- auth mode resolution (boot-time fail-closed policy) ---------------------

maybe('auth mode: Clerk secret opts in; AUTH_MODE wins; production forbids test mode', () => {
  assert.equal(resolveAuthMode({}), 'test');
  assert.equal(resolveAuthMode({ CLERK_SECRET_KEY: 'sk_live_x' }), 'clerk');
  assert.equal(resolveAuthMode({ AUTH_MODE: 'clerk', NODE_ENV: 'production' }), 'clerk');
  assert.equal(resolveAuthMode({ AUTH_MODE: 'test' }), 'test');
  // Production must never run header-based auth — even when no Clerk secret
  // is configured, the server refuses to boot instead of trusting x-org-id.
  assert.throws(() => resolveAuthMode({ NODE_ENV: 'production' }), /AUTH_MODE=clerk.*required in production/);
  assert.throws(() => resolveAuthMode({ AUTH_MODE: 'test', NODE_ENV: 'production' }), /required in production/);
});

// --- RBAC -------------------------------------------------------------------

async function withRole(roleClaim) {
  return withApp(claimsFor('org_rbac', roleClaim));
}

/** Start an app with a custom clerk stub and return { base, close }. */
async function withApp(clerkClient) {
  const app = createApp(createMemoryRepos(), { auth: { mode: 'clerk', clerkClient }, kek: KEK });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { base: `http://127.0.0.1:${srv.address().port}/api`, close: () => srv.close() };
}

maybe('viewer can read but not write', async () => {
  const { base: b, close } = await withRole('org:viewer');
  try {
    const post = await fetch(`${b}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer() },
      body: JSON.stringify({ prompt: 'x' }),
    });
    assert.equal(post.status, 403);
    assert.equal((await json(post)).error, 'FORBIDDEN');

    const list = await fetch(`${b}/projects`, { headers: bearer() });
    assert.equal(list.status, 200);
  } finally {
    close();
  }
});

maybe('architect can write but not delete', async () => {
  const { base: b, close } = await withRole('org:architect');
  try {
    const created = await json(
      await fetch(`${b}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({ prompt: 'summarise my emails' }),
      }),
    );
    assert.ok(created.id);

    const del = await fetch(`${b}/projects/${created.id}`, { method: 'DELETE', headers: bearer() });
    assert.equal(del.status, 403);

    const get = await fetch(`${b}/projects/${created.id}`, { headers: bearer() });
    assert.equal(get.status, 200);
  } finally {
    close();
  }
});

maybe('owner can delete; unknown role fails closed', async () => {
  const { base: b, close } = await withRole('org:admin');
  try {
    const created = await json(
      await fetch(`${b}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer() },
        body: JSON.stringify({ prompt: 'summarise my emails' }),
      }),
    );
    const del = await fetch(`${b}/projects/${created.id}`, { method: 'DELETE', headers: bearer() });
    assert.equal(del.status, 200);
  } finally {
    close();
  }

  const { base: b2, close: close2 } = await withRole('org:totally-made-up');
  try {
    const r = await fetch(`${b2}/projects`, { headers: bearer() });
    assert.equal(r.status, 403, 'unknown roles must fail closed');
  } finally {
    close2();
  }
});
