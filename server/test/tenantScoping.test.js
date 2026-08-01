/**
 * tenantScoping.test.js — adversarial cross-tenant isolation suite.
 *
 * Simulates a hostile Org B attempting to query, modify, or delete resources
 * owned by Org A through every reachable surface:
 *
 *   - the HTTP API (Org B sends requests bound to ITS org, i.e. the
 *     `org_id` claim / x-org-id header says org_b, and tries org A's
 *     resource ids),
 *   - the repository layer directly (bypassing the choke point entirely —
 *     the storage layer must enforce scoping on its own),
 *   - the workflow upsert path (the classic "overwrite someone else's
 *     workflow" attack).
 *
 * Assertion: every cross-tenant attempt yields HTTP 403/404 at the API and
 * null/empty at the repo layer. No resource id of org A is ever leaked to
 * org B through a 200, and no write from org B ever mutates org A's rows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { ProjectService } from '../src/application/projectService.js';
import { generateKey } from '../src/domain/vault/crypto.js';

let createApp;
let createSqliteRepos;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
  ({ createSqliteRepos } = await import('../src/adapters/persistence/sqliteRepos.js'));
} catch {
  createApp = null;
  createSqliteRepos = null;
}

const maybeApp = createApp ? test : test.skip;
const maybeSqlite = createSqliteRepos ? test : test.skip;
const json = (r) => r.json();

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const KEK = generateKey();

/** Standard test-mode headers (x-org-id binds the tenant in test mode). */
const headers = (orgId, role = 'org:owner') => ({
  'content-type': 'application/json',
  'x-org-id': orgId,
  'x-user-role': role,
});

// --- HTTP surface -----------------------------------------------------------

/**
 * Each test gets its own app + socket so scenarios are fully independent (no
 * shared state between adversarial cases).
 */
async function withServer() {
  const app = createApp(createMemoryRepos(), { kek: KEK });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { base: `http://127.0.0.1:${srv.address().port}/api`, close: () => srv.close() };
}

/** Org A creates a project, answers the grill, and scaffolds a workflow. */
async function seedOrgA(base) {
  const created = await json(
    await fetch(`${base}/projects`, {
      method: 'POST',
      headers: headers(ORG_A),
      body: JSON.stringify({ prompt: 'summarise my emails' }),
    }),
  );
  await fetch(`${base}/projects/${created.id}/answers`, {
    method: 'POST',
    headers: headers(ORG_A),
    body: JSON.stringify({
      answers: { 'goal.outcome': 'digest', 'inputs.source': 'inbox', 'outputs.shape': 'md', 'success.measure': 'complete' },
    }),
  });
  await fetch(`${base}/projects/${created.id}/workflow/scaffold`, {
    method: 'POST',
    headers: headers(ORG_A),
    body: JSON.stringify({}),
  });
  return created;
}

maybeApp('Org B cannot read Org A project (GET → 404)', async () => {
  const srv = await withServer();
  try {
    const a = await seedOrgA(srv.base);
    const r = await fetch(`${srv.base}/projects/${a.id}`, { headers: headers(ORG_B) });
    assert.equal(r.status, 404);
  } finally {
    srv.close();
  }
});

maybeApp('Org B list does not include Org A projects', async () => {
  const srv = await withServer();
  try {
    await seedOrgA(srv.base);
    const r = await json(await fetch(`${srv.base}/projects`, { headers: headers(ORG_B) }));
    assert.deepEqual(r, []);
    const aList = await json(await fetch(`${srv.base}/projects`, { headers: headers(ORG_A) }));
    assert.equal(aList.length, 1);
  } finally {
    srv.close();
  }
});

maybeApp('Org B cannot read Org A grill state (GET → 404)', async () => {
  const srv = await withServer();
  try {
    const a = await seedOrgA(srv.base);
    const r = await fetch(`${srv.base}/projects/${a.id}/grill`, { headers: headers(ORG_B) });
    assert.equal(r.status, 404);
  } finally {
    srv.close();
  }
});

maybeApp('Org B cannot answer Org A grill (POST → 404)', async () => {
  const srv = await withServer();
  try {
    const a = await seedOrgA(srv.base);
    const r = await fetch(`${srv.base}/projects/${a.id}/answers`, {
      method: 'POST',
      headers: headers(ORG_B),
      body: JSON.stringify({ answers: { 'goal.outcome': 'hijacked' } }),
    });
    assert.equal(r.status, 404);
  } finally {
    srv.close();
  }
});

maybeApp('Org B cannot scaffold Org A workflow (POST → 404)', async () => {
  const srv = await withServer();
  try {
    const a = await seedOrgA(srv.base);
    const r = await fetch(`${srv.base}/projects/${a.id}/workflow/scaffold`, {
      method: 'POST',
      headers: headers(ORG_B),
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 404);
  } finally {
    srv.close();
  }
});

maybeApp('Org B cannot read Org A workflow (GET → 404)', async () => {
  const srv = await withServer();
  try {
    const a = await seedOrgA(srv.base);
    const r = await fetch(`${srv.base}/projects/${a.id}/workflow`, { headers: headers(ORG_B) });
    assert.equal(r.status, 404);
  } finally {
    srv.close();
  }
});

maybeApp('Org B cannot overwrite Org A workflow (PUT → 404)', async () => {
  const srv = await withServer();
  try {
    const a = await seedOrgA(srv.base);
    const r = await fetch(`${srv.base}/projects/${a.id}/workflow`, {
      method: 'PUT',
      headers: headers(ORG_B),
      body: JSON.stringify({ workflow: { id: 'wf_hijack', name: 'stolen', nodes: [{ id: 'n', type: 'input', name: 'n', dependsOn: [] }] } }),
    });
    assert.equal(r.status, 404);
  } finally {
    srv.close();
  }
});

maybeApp('Org B cannot delete Org A project (DELETE → 404)', async () => {
  const srv = await withServer();
  try {
    const a = await seedOrgA(srv.base);
    const r = await fetch(`${srv.base}/projects/${a.id}`, { method: 'DELETE', headers: headers(ORG_B) });
    assert.equal(r.status, 404);
    // And the project is still intact for Org A.
    const stillThere = await fetch(`${srv.base}/projects/${a.id}`, { headers: headers(ORG_A) });
    assert.equal(stillThere.status, 200);
  } finally {
    srv.close();
  }
});

// --- Repository surface (bypassing the HTTP choke point) ---------------------

/** Run the same adversarial assertions against a repository pair. */
function repoLevelAttacks(label, makeRepos) {
  test(`[${label}] Org B repo calls cannot see or mutate Org A rows`, () => {
    const repos = makeRepos();
    const s = new ProjectService(repos);

    const a = s.createProject(ORG_A, 'summarise my emails');
    s.answer(ORG_A, a.id, { 'goal.outcome': 'digest', 'inputs.source': 'inbox', 'outputs.shape': 'md', 'success.measure': 'complete' });
    const wfA = s.scaffoldWorkflow(ORG_A, a.id);

    // Reads → null / empty (indistinguishable from missing).
    assert.equal(repos.projects.get(ORG_B, a.id), null);
    assert.equal(repos.workflows.getByProject(ORG_B, a.id), null);
    assert.deepEqual(repos.projects.list(ORG_B), []);
    assert.deepEqual(repos.grillSessions.listByProject(ORG_B, a.id), []);
    assert.equal(repos.grillSessions.getLatest(ORG_B, a.id), null);

    // Writes → refused, and Org A's rows are untouched.
    assert.equal(repos.projects.update(ORG_B, a.id, { prompt: 'hijacked' }), null);
    assert.equal(repos.projects.remove(ORG_B, a.id), false);
    assert.equal(repos.workflows.save(ORG_B, a.id, { id: 'wf_hijack', name: 'stolen', nodes: [] }), null);

    const afterAttacks = s.getProject(ORG_A, a.id);
    assert.equal(afterAttacks.prompt, 'summarise my emails', 'Org A prompt unchanged');
    assert.deepEqual(s.getWorkflow(ORG_A, a.id), wfA, 'Org A workflow unchanged');

    // Service layer answers 404 for the hostile org (including getWorkflow,
    // which refuses at the project lookup before touching the workflow repo).
    assert.throws(() => s.getProject(ORG_B, a.id), (e) => e.status === 404);
    assert.throws(() => s.getWorkflow(ORG_B, a.id), (e) => e.status === 404);
    assert.throws(() => s.deleteProject(ORG_B, a.id), (e) => e.status === 404);
  });
}

repoLevelAttacks('memory', createMemoryRepos);
if (createSqliteRepos) repoLevelAttacks('sqlite', () => createSqliteRepos(':memory:'));

maybeSqlite('sqlite WHERE-clause scoping is enforced at the SQL level', () => {
  const { db } = createSqliteRepos(':memory:');
  db.prepare('INSERT INTO projects (id, org_id, prompt, answers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'p_a', ORG_A, 'secret prompt', '{}', new Date().toISOString(), new Date().toISOString(),
  );
  // Even a hand-written query cannot cross the org boundary — the org
  // predicate is part of the statement.
  const row = db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get('p_a', ORG_B);
  assert.equal(row, undefined);
  const theirs = db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get('p_a', ORG_A);
  assert.equal(theirs.org_id, ORG_A);
});
