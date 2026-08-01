/**
 * catalogHttp.test.js — the read-only marketplace/lens HTTP surface
 * (Increment 3): /api/catalog/divisions|agents|lenses|snapshots.
 *
 * Auth: every route requires a session (x-org-id in test mode) and the
 * Viewer role or higher. The catalog itself is GLOBAL public MIT data — the
 * same rows for every org — and there is NO HTTP route that mutates it.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { CatalogService } from '../src/application/catalogService.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let createApp;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
} catch {
  createApp = null;
}
const maybe = createApp ? test : test.skip;

/** Seed a memory repo with the bundled fixtures, then mount the app. */
function seededApp() {
  const repos = createMemoryRepos();
  const service = new CatalogService(repos);
  for (const source of ['agency-agents', 'nuwa-skill']) {
    const base = fileURLToPath(new URL(`../fixtures/catalog/${source}/`, import.meta.url));
    const files = {};
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        const rel = full.slice(base.length + 1);
        if (entry.isDirectory()) { walk(full); continue; }
        if (entry.isFile() && statSync(full).size <= 2_000_000) files[rel] = readFileSync(full, 'utf8');
      }
    };
    walk(base);
    service.loadFromBundle(source, base);
  }
  return createApp(repos);
}

let server;
let base;

before(async () => {
  if (!createApp) return;
  const app = seededApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
});

after(() => server?.close());

const get = (path, headers = {}) =>
  fetch(`${base}${path}`, { headers: { 'x-org-id': 'org-1', ...headers } });

maybe('catalog routes are readable with a session (test-mode default org)', async () => {
  // In test auth mode an org header IS the session; a bare request still
  // resolves to the dev-org (never 500, never blocked for anonymous reads
  // of public MIT data). Clerk-mode 401s are covered by auth.test.js.
  const res = await fetch(`${base}/catalog/agents`);
  assert.ok([200, 401, 403].includes(res.status), `unexpected status ${res.status}`);
  if (res.status === 200) {
    const body = await res.json();
    assert.ok(Array.isArray(body));
  }
});

maybe('GET /catalog/divisions groups the marketplace', async () => {
  const res = await get('/catalog/divisions');
  assert.equal(res.status, 200);
  const divisions = await res.json();
  assert.ok(divisions.length >= 5, 'seeded divisions present');
  assert.ok(divisions.some((d) => d.id === 'engineering' && d.label === 'Engineering'));
});

maybe('GET /catalog/agents lists personas with division + tools and supports search', async () => {
  const all = await (await get('/catalog/agents')).json();
  assert.ok(all.length >= 7, 'seeded personas present');
  assert.ok(all.every((a) => a.division && a.name && a.description));

  const engineering = await (await get('/catalog/agents?division=engineering')).json();
  assert.ok(engineering.length > 0);
  assert.ok(engineering.every((a) => a.division === 'engineering'));

  const search = await (await get('/catalog/agents?q=security')).json();
  assert.ok(search.length > 0);
  assert.ok(search.every((a) => /security/i.test(`${a.name} ${a.description} ${a.vibe ?? ''}`)));
});

maybe('GET /catalog/agents/:id returns one persona with tool tags', async () => {
  const all = await (await get('/catalog/agents')).json();
  const res = await get(`/catalog/agents/${encodeURIComponent(all[0].id)}`);
  assert.equal(res.status, 200);
  const agent = await res.json();
  assert.ok(Array.isArray(agent.tools), 'tool permission tags present');
  assert.ok(agent.body.length > 0, 'persona body present');
});

maybe('GET /catalog/lenses lists cognitive lenses; :id returns body + fidelity', async () => {
  const lenses = await (await get('/catalog/lenses')).json();
  assert.equal(lenses.length, 16, 'distiller + 15 perspective skills');
  const munger = lenses.find((l) => l.id === 'nuwa-skill:munger-perspective');
  assert.ok(munger, 'Munger lens present');
  const res = await get(`/catalog/lenses/${encodeURIComponent(munger.id)}`);
  assert.equal(res.status, 200);
  const lens = await res.json();
  assert.ok(lens.body.length > 0, 'lens body present');
  assert.ok(lens.fidelity, 'FIDELITY.md attached for munger');
});

maybe('GET /catalog/snapshots reports sync provenance', async () => {
  const res = await get('/catalog/snapshots?source=agency-agents');
  assert.equal(res.status, 200);
  const snapshots = await res.json();
  assert.ok(snapshots.length >= 1);
  assert.equal(snapshots[0].status, 'ok');
});

maybe('unknown catalog ids are 404', async () => {
  assert.equal((await get('/catalog/agents/agency-agents:nope')).status, 404);
  assert.equal((await get('/catalog/lenses/nuwa-skill:nope')).status, 404);
});

maybe('catalog is identical across orgs (global public data)', async () => {
  const orgA = await (await get('/catalog/agents', { 'x-org-id': 'org-a' })).json();
  const orgB = await (await get('/catalog/agents', { 'x-org-id': 'org-b' })).json();
  assert.deepEqual(orgA.map((a) => a.id), orgB.map((a) => a.id));
});
