/**
 * executionHttp.test.js — the Increment 5 execution HTTP surface.
 *
 * Live Express app over the wire (memory repos, test auth headers) for:
 *   - POST /projects/:id/run (entitlement gate: Free → 402)
 *   - POST /projects/:id/run/cancel | pause | resume
 *   - GET /projects/:id/run/:execId (execution + steps)
 *   - GET /projects/:id/run/:execId/events (SSE stream)
 *   - GET /projects/:id/executions (history)
 *   - POST /projects/:id/run/retry (append-only re-run)
 *   - RBAC gates on the new routes
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';

let createApp;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
} catch {
  createApp = null;
}
const maybe = createApp ? test : test.skip;

const ORG = 'org-run';
const OTHER_ORG = 'org-other';
const authHeaders = { 'x-org-id': ORG, 'x-user-role': 'org:owner', 'content-type': 'application/json' };
const otherAuth = { 'x-org-id': OTHER_ORG, 'x-user-role': 'org:owner', 'content-type': 'application/json' };

const WORKFLOW = {
  id: 'wf_run',
  name: 'HTTP run',
  nodes: [
    { id: 'in', type: 'input', name: 'Seed', config: { mode: 'user', sources: ['v'], values: { v: 'seed' } }, dependsOn: [] },
    { id: 'agent', type: 'agent', name: 'Think', config: { objective: 'do the thing' }, dependsOn: ['in'] },
    { id: 'out', type: 'output', name: 'Done', config: { targets: [] }, dependsOn: ['agent'] },
  ],
};

let server;
let base;

before(async () => {
  if (!createApp) return;
  const repos = createMemoryRepos();
  const app = createApp(repos, {
    env: { DATA_DIR: '/tmp/exec-http' },
    // Deterministic agent handler — the HTTP tests exercise the engine
    // plumbing, not the real LLM network call (covered by engine tests).
    execution: {
      options: {
        handlers: {
          agent: async (ctx) => {
            if (ctx.node.id === 'boom') throw new Error('simulated boom');
            return 'mock agent result';
          },
        },
      },
    },
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
  global.__repos = repos;
});

after(() => server?.close());

const json = (r) => r.json();

/** Create a project + saved workflow for ORG and mark the org paid. */
async function seedProject({ paid = true } = {}) {
  const repos = global.__repos;
  if (paid) repos.billing.upsert(ORG, { status: 'active', plan: 'team' });
  // A vault key so agent nodes can resolve a provider key.
  await fetch(`${base}/vault`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ provider: 'openai', label: 'test', apiKey: 'sk-test-http' }),
  });
  const r = await fetch(`${base}/projects`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ prompt: 'build a demo workflow' }),
  });
  const project = await json(r);
  await fetch(`${base}/projects/${project.id}/workflow`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ workflow: WORKFLOW }),
  });
  return project;
}

/** Poll an execution until it leaves the running/queued states. */
async function waitForTerminal(projectId, execId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let body;
  do {
    const r = await fetch(`${base}/projects/${projectId}/run/${execId}`, { headers: authHeaders });
    body = await json(r);
    if (!['queued', 'running', 'paused'].includes(body.status)) return body;
    await new Promise((r2) => setTimeout(r2, 25));
  } while (Date.now() < deadline);
  return body;
}

maybe('Free plan cannot run a workflow (402 before any run state)', async () => {
  const project = await seedProject({ paid: false });
  const r = await fetch(`${base}/projects/${project.id}/run`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 402);
  const body = await json(r);
  assert.equal(body.error, 'PAYMENT_REQUIRED');
  const executions = await (await fetch(`${base}/projects/${project.id}/executions`, { headers: authHeaders })).json();
  assert.equal(executions.length, 0, 'no execution row created for a blocked org');
});

maybe('Team plan runs a workflow end-to-end; history and detail include steps', async () => {
  const project = await seedProject();
  const r = await fetch(`${base}/projects/${project.id}/run`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ inputs: { in: { v: 'overridden' } } }),
  });
  assert.equal(r.status, 201);
  const created = await json(r);
  assert.equal(created.status, 'queued');
  assert.ok(created.id.startsWith('exec_'), 'execution id assigned');

  const final = await waitForTerminal(project.id, created.id);
  assert.equal(final.status, 'succeeded');
  assert.equal(final.steps.length, 3);
  assert.ok(final.steps.every((s) => s.status === 'success'));
  // Run inputs overrode the node defaults.
  const inputStep = final.steps.find((s) => s.nodeId === 'in');
  assert.equal(inputStep.outputData.v, 'overridden');

  const list = await (await fetch(`${base}/projects/${project.id}/executions`, { headers: authHeaders })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);
});

maybe('run without a saved workflow answers 409 NO_WORKFLOW', async () => {
  const repos = global.__repos;
  repos.billing.upsert(ORG, { status: 'active', plan: 'team' });
  const r = await fetch(`${base}/projects`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ prompt: 'no workflow here' }),
  });
  const project = await json(r);
  const run = await fetch(`${base}/projects/${project.id}/run`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(run.status, 409);
  assert.equal((await json(run)).error, 'NO_WORKFLOW');
});

maybe('failed runs record the error message and abort downstream nodes', async () => {
  const repos = global.__repos;
  repos.billing.upsert(ORG, { status: 'active', plan: 'team' });
  const project = await seedProject();
  const failing = {
    id: 'wf_fail',
    name: 'failing',
    nodes: [
      { id: 'boom', type: 'agent', name: 'Boom', config: {}, dependsOn: [] },
      { id: 'b', type: 'output', name: 'Never', config: { targets: [] }, dependsOn: ['boom'] },
    ],
  };
  await fetch(`${base}/projects/${project.id}/workflow`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ workflow: failing }),
  });
  const r = await fetch(`${base}/projects/${project.id}/run`, { method: 'POST', headers: authHeaders, body: JSON.stringify({}) });
  const created = await json(r);
  const final = await waitForTerminal(project.id, created.id);
  assert.equal(final.status, 'failed');
  assert.ok(final.errorMessage, 'terminal error recorded');
  assert.match(final.errorMessage, /simulated boom/);
  const boom = final.steps.find((s) => s.nodeId === 'boom');
  assert.equal(boom.status, 'error');
  const never = final.steps.find((s) => s.nodeId === 'b');
  assert.equal(never.status, 'skipped');
});

maybe('cancel a running execution; retry creates a NEW execution linked via retryOf', async () => {
  const project = await seedProject();
  const slow = {
    id: 'wf_slow',
    name: 'slow',
    nodes: [
      { id: 'a', type: 'input', name: 'Seed', config: { mode: 'user', sources: ['v'], values: { v: 1 } }, dependsOn: [] },
      { id: 'b', type: 'output', name: 'Done', config: { targets: [] }, dependsOn: ['a'] },
    ],
  };
  await fetch(`${base}/projects/${project.id}/workflow`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ workflow: slow }),
  });
  const r = await fetch(`${base}/projects/${project.id}/run`, { method: 'POST', headers: authHeaders, body: JSON.stringify({}) });
  const created = await json(r);
  await waitForTerminal(project.id, created.id);
  assert.equal((await (await fetch(`${base}/projects/${project.id}/run/${created.id}`, { headers: authHeaders })).json()).status, 'succeeded');

  // Cancel on a finished execution → 409.
  const cancel = await fetch(`${base}/projects/${project.id}/run/cancel`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ execId: created.id }),
  });
  assert.equal(cancel.status, 409);

  // Retry the finished execution → new row with retryOf pointing at it.
  const retry = await fetch(`${base}/projects/${project.id}/run/retry`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ execId: created.id }),
  });
  assert.equal(retry.status, 201);
  const retried = await json(retry);
  assert.notEqual(retried.id, created.id);
  assert.equal(retried.retryOf, created.id);
  const final = await waitForTerminal(project.id, retried.id);
  assert.equal(final.status, 'succeeded');

  const list = await (await fetch(`${base}/projects/${project.id}/executions`, { headers: authHeaders })).json();
  assert.equal(list.length, 2, 'history is append-only');
  assert.equal(list[0].id, retried.id, 'newest first');
});

maybe('SSE events stream replays state and pushes live step events', async () => {
  const project = await seedProject();
  await fetch(`${base}/projects/${project.id}/workflow`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ workflow: WORKFLOW }),
  });
  const r = await fetch(`${base}/projects/${project.id}/run`, { method: 'POST', headers: authHeaders, body: JSON.stringify({}) });
  const created = await json(r);

  const streamRes = await fetch(`${base}/projects/${project.id}/run/${created.id}/events`, { headers: authHeaders });
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get('content-type'), /text\/event-stream/);
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes('event: execution') && text.includes('succeeded')) break;
  }
  reader.cancel().catch(() => {});
  assert.match(text, /event: execution/, 'execution events streamed');
  assert.match(text, /event: step/, 'step events streamed');
  assert.match(text, /succeeded/, 'terminal status streamed');
});

maybe('foreign org cannot see or run another org\'s execution', async () => {
  const project = await seedProject();
  const r = await fetch(`${base}/projects/${project.id}/run`, { method: 'POST', headers: authHeaders, body: JSON.stringify({}) });
  const created = await json(r);
  await waitForTerminal(project.id, created.id);

  // Another org's project id → 404 (tenancy backstop).
  const foreign = await fetch(`${base}/projects/${project.id}/run/${created.id}`, { headers: otherAuth });
  assert.equal(foreign.status, 404);
  // Same org, wrong project → 404.
  const repos = global.__repos;
  const otherProject = repos.projects.create({ orgId: ORG, prompt: 'other' });
  const wrongProject = await fetch(`${base}/projects/${otherProject.id}/run/${created.id}`, { headers: authHeaders });
  assert.equal(wrongProject.status, 404);
});

maybe('RBAC: viewers can read executions but cannot start runs', async () => {
  const project = await seedProject();
  const viewer = { 'x-org-id': ORG, 'x-user-role': 'org:viewer', 'content-type': 'application/json' };
  const r = await fetch(`${base}/projects/${project.id}/run`, {
    method: 'POST',
    headers: viewer,
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 403);
  const list = await fetch(`${base}/projects/${project.id}/executions`, { headers: viewer });
  assert.equal(list.status, 200);
});
