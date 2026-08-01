import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';

// The HTTP adapter needs express (a real dependency). Skip the whole file on a
// bare checkout where `npm install` hasn't run yet, so `node --test` still
// exercises the dependency-free domain + service layers.
let createApp;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
} catch {
  createApp = null;
}

const maybe = createApp ? test : test.skip;

let server;
let base;

before(async () => {
  if (!createApp) return;
  const app = createApp(createMemoryRepos());
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
});

after(() => server?.close());

const json = (r) => r.json();

maybe('health check responds with status, version, uptime and DB readiness', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const body = await json(r);
  assert.equal(body.status, 'ok');
  assert.ok(body.version, 'health payload exposes a service version');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(body.db.ok, true, 'health payload reports database readiness');
  assert.equal(typeof body.db.latencyMs, 'number');
});

maybe('health returns 503 when the database is unreachable', async () => {
  const repos = createMemoryRepos();
  repos.ping = () => ({ ok: false, error: 'disk on fire' });
  const app = createApp(repos);
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const b = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const r = await fetch(`${b}/health`);
    assert.equal(r.status, 503);
    const body = await json(r);
    assert.equal(body.status, 'degraded');
    assert.equal(body.db.ok, false);
    assert.ok(body.db.error);
  } finally {
    srv.close();
  }
});

maybe('CORS pre-flight is answered for a dev origin', async () => {
  const r = await fetch(`${base}/projects`, {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

maybe('CORS does not reflect a disallowed origin', async () => {
  const r = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example.com' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

maybe('end-to-end over HTTP: create, grill, answer, scaffold', async () => {
  const created = await fetch(`${base}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'summarise my emails' }),
  });
  assert.equal(created.status, 201);
  const project = await json(created);

  const grill = await json(await fetch(`${base}/projects/${project.id}/grill`));
  assert.equal(grill.ready, false);

  const answered = await fetch(`${base}/projects/${project.id}/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      answers: {
        'goal.outcome': 'a digest',
        'inputs.source': 'inbox',
        'outputs.shape': 'markdown',
        'success.measure': 'nothing urgent missed',
      },
    }),
  });
  assert.equal(answered.status, 200);

  const scaffold = await fetch(`${base}/projects/${project.id}/workflow/scaffold`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(scaffold.status, 201);
  const wf = await json(scaffold);
  assert.ok(wf.nodes.length >= 3);
});

maybe('validation errors surface as 422', async () => {
  const created = await json(
    await fetch(`${base}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x produces y from z, correct when done' }),
    }),
  );
  const r = await fetch(`${base}/projects/${created.id}/workflow`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow: { id: 'w', name: 'bad', nodes: [{ id: 'a', type: 'bogus', name: 'A', dependsOn: [] }] } }),
  });
  assert.equal(r.status, 422);
  assert.equal((await json(r)).error, 'INVALID_WORKFLOW');
});

maybe('unknown project is 404', async () => {
  const r = await fetch(`${base}/projects/does-not-exist`);
  assert.equal(r.status, 404);
});
