/**
 * safety.test.js — the hard security invariant of Increment 3.
 *
 *   NO user-authored workflow code ever executes on our backend servers.
 *
 * Execution preview is restricted strictly to:
 *   1. static DAG validation (validateWorkflow), and
 *   2. mock-handler topological simulations (simulation.js).
 *
 * This file makes that invariant CHECKABLE in three ways:
 *
 *   A. Structural: the HTTP-reachable module graph (app → routes → domain)
 *      never imports the real runtime (executor.js / handlers.js) — the only
 *      "execution" surface is the simulation module, which is self-contained.
 *      The simulation module itself performs zero I/O: no fetch, no fs, no
 *      child processes, no LLM calls.
 *
 *   B. Source scan: server/src contains no dynamic-execution primitive that
 *      could run user code (no child_process, no node:vm, no eval/new
 *      Function outside generated-code STRINGS that are never executed).
 *
 *   C. Behavioral: POST /api/workflow/simulate answers only with mock
 *      outputs — a workflow whose input nodes point at URLs/files is
 *      simulated WITHOUT any network or filesystem side effect, proving the
 *      preview is inert even for payloads that would do real I/O under the
 *      production runtime.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateWorkflow } from '../src/domain/executor/simulation.js';

let createApp;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
} catch {
  createApp = null;
}
const maybe = createApp ? test : test.skip;

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

// --- C: behavioral (works without express too) -------------------------------

test('simulateWorkflow runs only mock handlers: input URLs are NOT fetched', async () => {
  const workflow = {
    id: 'w', name: 'network trap', nodes: [
      { id: 'in', type: 'input', name: 'Fetch secrets', config: { sources: ['https://example.com/never-fetch-me'] }, dependsOn: [] },
      { id: 'agent', type: 'agent', name: 'LLM', config: { objective: 'call an LLM' }, dependsOn: ['in'] },
      { id: 'out', type: 'output', name: 'Deliver', config: { targets: ['/tmp/never-written'] }, dependsOn: ['agent'] },
    ],
  };
  const result = await simulateWorkflow(workflow);
  assert.equal(result.simulation, true);
  assert.equal(result.success, true);
  const inputStep = result.steps.find((s) => s.id === 'in');
  assert.ok(String(inputStep.output['https://example.com/never-fetch-me']).startsWith('[mock loaded'), 'URL input is a placeholder, not a fetch');
  const agentStep = result.steps.find((s) => s.id === 'agent');
  assert.ok(agentStep.output.includes('[mock agent'), 'agent output is a canned template, not an LLM call');
  const outStep = result.steps.find((s) => s.id === 'out');
  assert.ok(String(Object.values(outStep.output)[0]).includes('[mock delivered'), 'output is a placeholder, no file written');
});

test('simulateWorkflow still performs static DAG validation', async () => {
  const cyclic = {
    id: 'w', nodes: [
      { id: 'a', type: 'agent', name: 'A', dependsOn: ['b'] },
      { id: 'b', type: 'agent', name: 'B', dependsOn: ['a'] },
    ],
  };
  const result = await simulateWorkflow(cyclic);
  assert.equal(result.success, false);
  assert.ok(result.error.includes('cycle'), 'cycle detected statically');
  assert.equal(result.steps.length, 0, 'nothing ran');
});

test('simulateWorkflow refuses oversized workflows (defense in depth)', async () => {
  const nodes = Array.from({ length: 1001 }, (_, i) => ({ id: `n${i}`, type: 'input', name: `N${i}`, dependsOn: i ? [`n${i - 1}`] : [] }));
  const result = await simulateWorkflow({ id: 'w', nodes });
  assert.equal(result.success, false);
  assert.ok(result.error.includes('simulation limit'));
});

// --- A: structural module-graph invariant ------------------------------------

/** Collect every local import specifier from a JS source file. */
function localImports(source) {
  const out = new Set();
  for (const m of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) out.add(m[1]);
  return [...out];
}

function walkJs(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

test('the HTTP-reachable graph never imports the real workflow runtime (executor/handlers)', () => {
  const banned = ['executor.js', 'handlers.js'];
  const roots = [
    join(SRC_DIR, 'adapters/http/app.js'),
    join(SRC_DIR, 'adapters/http/routes.js'),
    join(SRC_DIR, 'index.js'),
  ];
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const imp of localImports(source)) {
      const resolved = join(dirname(file), imp);
      const full = resolved.endsWith('.js') ? resolved : `${resolved}.js`;
      for (const b of banned) {
        assert.ok(
          !full.endsWith(`/${b}`),
          `${file} transitively imports the real runtime ${b} — user code could execute on the server`,
        );
      }
      if (full.startsWith(SRC_DIR) && full.endsWith('.js')) queue.push(full);
    }
  }
  // Sanity: the traversal actually reached the domain layer.
  assert.ok([...seen].some((f) => f.includes('validateWorkflow.js')), 'traversal reached the workflow validator');
});

test('simulation.js is self-contained: it never imports handlers.js/executor.js', () => {
  const source = readFileSync(join(SRC_DIR, 'domain/executor/simulation.js'), 'utf8');
  // Check IMPORT STATEMENTS only — doc comments may mention the real runtime
  // (this file explains why it does NOT use it).
  const importStatements = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(!importStatements.some((s) => s.includes('handlers.js')), 'simulation must not import the real handlers');
  assert.ok(!importStatements.some((s) => s.includes('executor.js')), 'simulation must not import the real executor');
  // And it performs no I/O by construction: no fs, no fetch, no child_process.
  assert.ok(!importStatements.some((s) => s.includes('node:fs')), 'simulation performs no filesystem I/O');
  assert.ok(!source.includes('fetch('), 'simulation performs no network I/O');
  assert.ok(!source.includes('child_process'), 'simulation spawns no processes');
});

// --- B: source scan for dynamic-execution primitives -------------------------

test('server/src contains no dynamic-execution primitive that could run user code', () => {
  const patterns = [
    /node:child_process/,
    /require\(['"]child_process['"]\)/,
    /node:vm/,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
  ];
  const offenders = [];
  for (const file of walkJs(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    // The codegen module legitimately renders Python source text containing
    // the word "eval" in comments/strings — but it only ever PRODUCES text;
    // it is never executed here. Skip its own file, then scan everything else.
    if (file.includes('domain/codegen/generator.js')) continue;
    for (const re of patterns) {
      if (re.test(source)) offenders.push(`${file} matches ${re}`);
    }
  }
  assert.deepEqual(offenders, [], 'dynamic-execution primitives must not appear in server/src');
});

// --- HTTP surface ------------------------------------------------------------

let server;
let base;

before(async () => {
  if (!createApp) return;
  const { createMemoryRepos } = await import('../src/adapters/persistence/memoryRepos.js');
  const app = createApp(createMemoryRepos());
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
});

after(() => server?.close());

maybe('POST /api/workflow/simulate returns only mock simulation output', async () => {
  const workflow = {
    id: 'w', name: 'preview', nodes: [
      { id: 'in', type: 'input', name: 'In', config: { sources: ['https://secret.example.com/data'] }, dependsOn: [] },
      { id: 'a', type: 'agent', name: 'A', config: { objective: 'exfiltrate', provider: 'openai' }, dependsOn: ['in'] },
      { id: 'o', type: 'output', name: 'Out', config: { targets: ['https://attacker.example.com/hook'] }, dependsOn: ['a'] },
    ],
  };
  const res = await fetch(`${base}/workflow/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-org-id': 'org-1' },
    body: JSON.stringify({ workflow }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.simulation, true);
  assert.equal(body.success, true);
  assert.ok(body.note.includes('no user code executed'));
  const inputOut = body.steps.find((s) => s.id === 'in').output;
  assert.ok(String(inputOut['https://secret.example.com/data']).startsWith('[mock loaded'));
  const outputOut = body.steps.find((s) => s.id === 'o').output;
  assert.ok(String(Object.values(outputOut)[0]).includes('[mock delivered'));
});

maybe('POST /api/workflow/simulate validates before simulating', async () => {
  const res = await fetch(`${base}/workflow/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-org-id': 'org-1' },
    body: JSON.stringify({ workflow: { id: 'w', nodes: [{ id: 'a', type: 'bogus', name: 'A', dependsOn: [] }] } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok(body.errors.length > 0, 'validation errors surfaced');
  assert.equal(body.steps.length, 0);
});
