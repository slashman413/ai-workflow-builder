/**
 * executionEngine.test.js — the Increment 5 execution engine.
 *
 * Exercises the DAG runner directly (no HTTP): happy path, concurrency
 * limit, per-step timeout, retry/backoff, conditional branch gating,
 * continue-on-error, error-handler recovery, abort, cancel, pause/resume,
 * and the built-in handlers (input/agent/tool/branch/output) including key
 * vault resolution and the closed tool set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { ExecutionEngine } from '../src/execution/engine.js';
import { createLogger, createHub } from '../src/execution/logger.js';
import { EXECUTION_STATUS, STEP_STATUS } from '../src/execution/types.js';

const ORG = 'org-1';

/** Run a workflow through a fresh engine to completion. */
async function runEngine({ workflow, injections = {}, options = {}, repos = createMemoryRepos() }) {
  const logger = createLogger({ executions: repos.executions, executionSteps: repos.executionSteps, hub: createHub() });
  const execution = repos.executions.create({ orgId: ORG, projectId: 'p1', workflowId: workflow.id, status: 'queued' });
  const engine = new ExecutionEngine({
    workflow,
    execution,
    logger,
    injections: { orgId: ORG, ...injections },
    options,
  });
  const final = await engine.run();
  const steps = repos.executionSteps.listByExecution(ORG, execution.id);
  return { execution: final, steps, engine, logger, repos };
}

const stepBy = (steps, id) => steps.find((s) => s.nodeId === id);

// ---------------------------------------------------------------------------
// Happy path + built-in handlers
// ---------------------------------------------------------------------------

test('input → agent → output runs end to end with real handlers (mock fetch + vault)', async () => {
  const calls = [];
  const vault = {
    list: () => [{ provider: 'openai', keyHandle: 'kh_1' }],
    revealKey: () => ({ provider: 'openai', apiKey: 'sk-test-123' }),
  };
  const fetchFn = async (url, opts) => {
    calls.push({ url, headers: opts?.headers });
    return {
      ok: true,
      text: async () => 'fetched remote content',
      json: async () => ({ choices: [{ message: { content: 'hello from llm' } }] }),
    };
  };
  const workflow = {
    id: 'wf_1',
    name: 'demo',
    nodes: [
      { id: 'in', type: 'input', name: 'Load', config: { sources: ['https://example.com/data'], mode: 'url' }, dependsOn: [] },
      { id: 'agent', type: 'agent', name: 'Analyze', config: { provider: 'openai', objective: 'summarize' }, dependsOn: ['in'] },
      { id: 'out', type: 'output', name: 'Deliver', config: { targets: ['webhook-ok'] }, dependsOn: ['agent'] },
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), 'exec-test-'));
  try {
    const { execution, steps } = await runEngine({
      workflow,
      injections: { vault, fetchFn, dataDir: dir },
    });
    assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED);
    assert.equal(execution.errorMessage, null);
    assert.equal(steps.length, 3);
    // input: URL was fetched (real handler path, not the mock simulation)
    const input = stepBy(steps, 'in');
    assert.equal(input.status, 'success');
    assert.equal(input.outputData['https://example.com/data'], 'fetched remote content');
    // agent: called the OpenAI-compatible endpoint with the vault key
    const agent = stepBy(steps, 'agent');
    assert.equal(agent.status, 'success');
    assert.equal(agent.outputData.content, 'hello from llm');
    assert.equal(agent.outputData.provider, 'openai');
    assert.ok(!JSON.stringify(agent.outputData).includes('sk-test'), 'key material never appears in the step output');
    assert.ok(calls.some((c) => c.headers?.Authorization === 'Bearer sk-test-123'), 'vault key used for the LLM call');
    // input snapshot: the agent step recorded its dependency's output
    assert.ok(agent.inputData.in, 'agent step input snapshot includes the input node output');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('input node in user mode reads run inputs', async () => {
  const workflow = {
    id: 'wf_u', name: 'user input', nodes: [
      { id: 'in', type: 'input', name: 'Ask', config: { mode: 'user', sources: ['topic'] }, dependsOn: [] },
      { id: 'out', type: 'output', name: 'Done', config: { targets: [] }, dependsOn: ['in'] },
    ],
  };
  const { execution, steps } = await runEngine({
    workflow,
    injections: { inputs: { in: { topic: 'quantum computing' } } },
  });
  assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED);
  assert.equal(stepBy(steps, 'in').outputData.topic, 'quantum computing');
});

test('agent node errors when the vault has no key for the provider', async () => {
  const workflow = {
    id: 'wf_v', name: 'vault miss', nodes: [
      { id: 'a', type: 'agent', name: 'LLM', config: { provider: 'anthropic' }, dependsOn: [] },
    ],
  };
  const { execution, steps } = await runEngine({
    workflow,
    injections: { vault: { list: () => [], revealKey: () => { throw new Error('nope'); } } },
  });
  assert.equal(execution.status, EXECUTION_STATUS.FAILED);
  assert.match(execution.errorMessage, /vault/);
  assert.equal(stepBy(steps, 'a').status, STEP_STATUS.ERROR);
});

test('tool node executes built-in tools and refuses unknown ones', async () => {
  const workflow = {
    id: 'wf_t', name: 'tools', nodes: [
      { id: 'in', type: 'input', name: 'Seed', config: { mode: 'user', sources: ['v'], values: { v: 'the quick brown fox jumps' } }, dependsOn: [] },
      { id: 'rule', type: 'tool', name: 'Check', config: { tool_id: 'rule.check', rules: ['quick brown fox'] }, dependsOn: ['in'] },
      { id: 'xf', type: 'tool', name: 'Pick', config: { tool_id: 'json.transform', operation: 'pick', paths: ['in.v'] }, dependsOn: ['in'] },
      { id: 'out', type: 'output', name: 'Done', config: { targets: [] }, dependsOn: ['rule', 'xf'] },
    ],
  };
  const { execution, steps } = await runEngine({ workflow });
  assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED);
  assert.equal(stepBy(steps, 'rule').outputData.result.passed, true);
  assert.equal(stepBy(steps, 'xf').outputData.result.picked['in.v'], 'the quick brown fox jumps');

  // Unknown tool id → the step fails with a clear error (closed tool set).
  const bad = {
    id: 'wf_tb', name: 'bad tool', nodes: [
      { id: 't', type: 'tool', name: 'Hack', config: { tool_id: 'run.arbitrary.code' }, dependsOn: [] },
    ],
  };
  const badRun = await runEngine({ workflow: bad });
  assert.equal(badRun.execution.status, EXECUTION_STATUS.FAILED);
  assert.match(stepBy(badRun.steps, 't').errorMessage, /no implementation/);
});

test('tool node legacy rule-check semantics (Inc 1 compatibility)', async () => {
  const workflow = {
    id: 'wf_legacy', name: 'legacy', nodes: [
      { id: 'in', type: 'input', name: 'Seed', config: { mode: 'user', sources: ['v'], values: { v: 'output contains the magic word' } }, dependsOn: [] },
      { id: 't', type: 'tool', name: 'Constraints', config: { constraints: ['magic word'] }, dependsOn: ['in'] },
    ],
  };
  const { execution, steps } = await runEngine({ workflow });
  assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED);
  assert.equal(stepBy(steps, 't').outputData.passed, true);
});

test('output node delivers to a webhook and writes files into the run sandbox', async () => {
  const seen = [];
  const fetchFn = async (url, opts) => {
    seen.push({ url, body: opts?.body });
    return { ok: true, status: 200 };
  };
  const dir = mkdtempSync(join(tmpdir(), 'exec-out-'));
  const workflow = {
    id: 'wf_o', name: 'output', nodes: [
      { id: 'in', type: 'input', name: 'Seed', config: { mode: 'user', sources: ['v'], values: { v: 42 } }, dependsOn: [] },
      { id: 'out', type: 'output', name: 'Deliver', config: { targets: ['https://hook.example.com/end', 'alerts@example.com'] }, dependsOn: ['in'] },
    ],
  };
  try {
    const { execution, steps } = await runEngine({ workflow, injections: { fetchFn, dataDir: dir } });
    assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED);
    const out = stepBy(steps, 'out');
    assert.match(out.outputData['https://hook.example.com/end'], /webhook .* 200/);
    assert.match(out.outputData['alerts@example.com'], /email draft written/);
    assert.equal(seen.length, 1, 'webhook POST fired once');
    assert.ok(seen[0].body.includes('42'), 'webhook payload carries the context');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scheduling: concurrency, timeout, retry
// ---------------------------------------------------------------------------

test('concurrency limit is enforced (max N parallel steps)', async () => {
  let active = 0;
  let maxActive = 0;
  const handler = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    return 'done';
  };
  const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, type: 'agent', name: `N${i}`, config: {}, dependsOn: [] }));
  const { execution, steps } = await runEngine({
    workflow: { id: 'wf_c', name: 'concurrency', nodes },
    options: { concurrency: 2, handlers: { agent: handler } },
  });
  assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED);
  assert.ok(maxActive <= 2, `max parallel was ${maxActive}, expected ≤ 2`);
  assert.equal(steps.filter((s) => s.status === 'success').length, 6);
});

test('per-step timeout fails the step with a clear message', async () => {
  const slow = async () => {
    await new Promise((r) => setTimeout(r, 5000));
    return 'too late';
  };
  const workflow = {
    id: 'wf_to', name: 'timeout', nodes: [
      { id: 'a', type: 'agent', name: 'Slow', config: { timeoutMs: 50 }, dependsOn: [] },
    ],
  };
  const { execution, steps } = await runEngine({
    workflow,
    options: { handlers: { agent: slow } },
  });
  assert.equal(execution.status, EXECUTION_STATUS.FAILED);
  const step = stepBy(steps, 'a');
  assert.equal(step.status, STEP_STATUS.ERROR);
  assert.match(step.errorMessage, /timed out after 50ms/);
});

test('retry with backoff: failing handler recovers on the 3rd attempt', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) throw new Error(`transient failure ${calls}`);
    return 'recovered';
  };
  const workflow = {
    id: 'wf_r', name: 'retry', nodes: [
      { id: 'a', type: 'agent', name: 'Flaky', config: { retries: 2, retryBackoffMs: 5 }, dependsOn: [] },
      { id: 'b', type: 'output', name: 'Done', config: { targets: [] }, dependsOn: ['a'] },
    ],
  };
  const { execution, steps } = await runEngine({
    workflow,
    options: { handlers: { agent: flaky } },
  });
  assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED);
  assert.equal(calls, 3, 'handler ran 3 times (2 retries)');
  const step = stepBy(steps, 'a');
  assert.equal(step.attempts, 3);
  assert.equal(step.outputData, 'recovered');
  assert.equal(stepBy(steps, 'b').status, STEP_STATUS.SUCCESS);
});

test('retries exhausted → step error with the final attempt count', async () => {
  const always = async () => { throw new Error('hard failure'); };
  const workflow = {
    id: 'wf_rf', name: 'retry fail', nodes: [
      { id: 'a', type: 'agent', name: 'Doomed', config: { retries: 1, retryBackoffMs: 5 }, dependsOn: [] },
    ],
  };
  const { execution, steps } = await runEngine({
    workflow,
    options: { handlers: { agent: always } },
  });
  assert.equal(execution.status, EXECUTION_STATUS.FAILED);
  const step = stepBy(steps, 'a');
  assert.equal(step.attempts, 2);
  assert.match(step.errorMessage, /hard failure/);
});

// ---------------------------------------------------------------------------
// Branching
// ---------------------------------------------------------------------------

test('branch condition gates dependents: only the matched path runs', async () => {
  const workflow = {
    id: 'wf_b', name: 'branch', nodes: [
      { id: 'in', type: 'input', name: 'Ask', config: { mode: 'user', sources: ['route'], values: { route: 'paid' } }, dependsOn: [] },
      { id: 'br', type: 'branch', name: 'Route', config: { conditions: [{ when: { nodeId: 'in', field: 'route', op: 'eq', value: 'paid' }, then: 'paidPath' }] }, dependsOn: ['in'] },
      { id: 'paidPath', type: 'output', name: 'Paid', config: { targets: [] }, dependsOn: ['br'] },
      { id: 'freePath', type: 'output', name: 'Free', config: { targets: [] }, dependsOn: ['br'] },
    ],
  };
  const { execution, steps } = await runEngine({ workflow });
  assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED);
  assert.equal(stepBy(steps, 'br').outputData.next, 'paidPath');
  assert.equal(stepBy(steps, 'paidPath').status, STEP_STATUS.SUCCESS);
  const free = stepBy(steps, 'freePath');
  assert.equal(free.status, STEP_STATUS.SKIPPED);
  assert.match(free.errorMessage, /branch decision/);
});

test('branch decisions map gates dependents explicitly', async () => {
  const workflow = {
    id: 'wf_bd', name: 'decisions', nodes: [
      { id: 'in', type: 'input', name: 'Seed', config: { mode: 'user', sources: ['v'], values: { v: 'x' } }, dependsOn: [] },
      { id: 'br', type: 'branch', name: 'Gate', config: { decisions: { left: true, right: false } }, dependsOn: ['in'] },
      { id: 'left', type: 'output', name: 'Left', config: { targets: [] }, dependsOn: ['br'] },
      { id: 'right', type: 'output', name: 'Right', config: { targets: [] }, dependsOn: ['br'] },
    ],
  };
  const { execution, steps } = await runEngine({ workflow });
  assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED);
  assert.equal(stepBy(steps, 'left').status, STEP_STATUS.SUCCESS);
  assert.equal(stepBy(steps, 'right').status, STEP_STATUS.SKIPPED);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test('unhandled failure aborts the run and marks remaining nodes skipped', async () => {
  const workflow = {
    id: 'wf_ab', name: 'abort', nodes: [
      { id: 'a', type: 'agent', name: 'Boom', config: {}, dependsOn: [] },
      { id: 'b', type: 'agent', name: 'Never', config: {}, dependsOn: ['a'] },
    ],
  };
  const { execution, steps } = await runEngine({
    workflow,
    options: { handlers: { agent: async (ctx) => { if (ctx.node.id === 'a') throw new Error('boom'); return 'ok'; } } },
  });
  assert.equal(execution.status, EXECUTION_STATUS.FAILED);
  assert.match(execution.errorMessage, /boom/);
  assert.equal(stepBy(steps, 'a').status, STEP_STATUS.ERROR);
  assert.equal(stepBy(steps, 'b').status, STEP_STATUS.SKIPPED);
  assert.match(stepBy(steps, 'b').errorMessage, /aborted at "a"/);
});

test('continue-on-error keeps the run alive; dependents read the error record', async () => {
  const workflow = {
    id: 'wf_coe', name: 'continue', nodes: [
      { id: 'a', type: 'agent', name: 'Fragile', config: { continueOnError: true }, dependsOn: [] },
      { id: 'b', type: 'output', name: 'After', config: { targets: [] }, dependsOn: ['a'] },
    ],
  };
  const { execution, steps } = await runEngine({
    workflow,
    options: { handlers: { agent: async (ctx) => { if (ctx.node.id === 'a') throw new Error('soft'); return 'ok'; } } },
  });
  assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED, 'run continues past a soft failure');
  assert.equal(stepBy(steps, 'a').status, STEP_STATUS.ERROR);
  assert.equal(stepBy(steps, 'b').status, STEP_STATUS.SUCCESS);
});

test('error-handler branch (Inc 1 semantics) recovers a failed dependency', async () => {
  const workflow = {
    id: 'wf_eh', name: 'error handler', nodes: [
      { id: 'a', type: 'agent', name: 'Fragile', config: {}, dependsOn: [] },
      { id: 'rescue', type: 'branch', name: 'Rescue', config: { handles: ['a'], onError: true }, dependsOn: ['a'] },
      { id: 'out', type: 'output', name: 'Done', config: { targets: [] }, dependsOn: ['rescue'] },
    ],
  };
  const { execution, steps } = await runEngine({
    workflow,
    options: { handlers: { agent: async (ctx) => { if (ctx.node.id === 'a') throw new Error('flaky'); return 'ok'; } } },
  });
  assert.equal(execution.status, EXECUTION_STATUS.SUCCEEDED, 'error-handler branch recovers the run');
  const rescue = stepBy(steps, 'rescue');
  assert.equal(rescue.status, STEP_STATUS.SUCCESS);
  assert.ok(rescue.outputData.handled.includes('a'));
  assert.equal(stepBy(steps, 'out').status, STEP_STATUS.SUCCESS);
});

test('error-handler branch that does not handle the failure still aborts', async () => {
  const workflow = {
    id: 'wf_ehn', name: 'unhandled', nodes: [
      { id: 'a', type: 'agent', name: 'Boom', config: {}, dependsOn: [] },
      { id: 'rescue', type: 'branch', name: 'WrongRescue', config: { handles: ['other'], onError: true }, dependsOn: ['a'] },
    ],
  };
  const { execution } = await runEngine({
    workflow,
    options: { handlers: { agent: async () => { throw new Error('kaboom'); } } },
  });
  assert.equal(execution.status, EXECUTION_STATUS.FAILED);
  assert.match(execution.errorMessage, /kaboom/);
});

test('workflow validation failure and cycles fail fast with no step rows', async () => {
  const bad = {
    id: 'wf_x', name: 'bad', nodes: [
      { id: 'a', type: 'agent', name: 'A', config: {}, dependsOn: ['b'] },
      { id: 'b', type: 'agent', name: 'B', config: {}, dependsOn: ['a'] },
    ],
  };
  const { execution, steps } = await runEngine({ workflow: bad });
  assert.equal(execution.status, EXECUTION_STATUS.FAILED);
  assert.match(execution.errorMessage, /cycle/);
  assert.equal(steps.length, 0);
});

// ---------------------------------------------------------------------------
// Controls: pause / resume / cancel
// ---------------------------------------------------------------------------

test('pause halts dispatching; resume continues; all steps eventually succeed', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const handler = async (ctx) => {
    if (ctx.node.id === 'a') await gate; // blocks until the test releases it
    return 'ok';
  };
  const nodes = ['a', 'b', 'c'].map((id) => ({ id, type: 'agent', name: id, config: {}, dependsOn: [] }));
  const repos = createMemoryRepos();
  const logger = createLogger({ executions: repos.executions, executionSteps: repos.executionSteps, hub: createHub() });
  const execution = repos.executions.create({ orgId: ORG, projectId: 'p1', workflowId: 'wf_p', status: 'queued' });
  const engine = new ExecutionEngine({
    workflow: { id: 'wf_p', name: 'pause', nodes },
    execution,
    logger,
    injections: { orgId: ORG },
    options: { concurrency: 1, handlers: { agent: handler } },
  });
  const runPromise = engine.run();

  // Wait for 'a' to start, then pause while it is blocked.
  await new Promise((r) => setTimeout(r, 30));
  engine.pause();
  release();
  await new Promise((r) => setTimeout(r, 30));
  // 'a' finished, nothing else dispatched while paused.
  assert.equal(repos.executionSteps.listByExecution(ORG, execution.id).length, 1, 'only node a ran while paused');

  engine.resume();
  const final = await runPromise;
  assert.equal(final.status, EXECUTION_STATUS.SUCCEEDED);
  const steps = repos.executionSteps.listByExecution(ORG, execution.id);
  assert.equal(steps.length, 3);
  assert.ok(steps.every((s) => s.status === STEP_STATUS.SUCCESS));
});

test('cancel aborts in-flight steps and marks the rest cancelled', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const handler = async (ctx) => {
    if (ctx.node.id === 'a') {
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    return 'ok';
  };
  const nodes = ['a', 'b'].map((id) => ({ id, type: 'agent', name: id, config: {}, dependsOn: [] }));
  const repos = createMemoryRepos();
  const logger = createLogger({ executions: repos.executions, executionSteps: repos.executionSteps, hub: createHub() });
  const execution = repos.executions.create({ orgId: ORG, projectId: 'p1', workflowId: 'wf_cx', status: 'queued' });
  const engine = new ExecutionEngine({
    workflow: { id: 'wf_cx', name: 'cancel', nodes },
    execution,
    logger,
    injections: { orgId: ORG },
    options: { concurrency: 1, handlers: { agent: handler } },
  });
  const runPromise = engine.run();

  await new Promise((r) => setTimeout(r, 30));
  engine.cancel();
  release();
  const final = await runPromise;
  assert.equal(final.status, EXECUTION_STATUS.CANCELLED);
  const steps = repos.executionSteps.listByExecution(ORG, execution.id);
  const statuses = Object.fromEntries(steps.map((s) => [s.nodeId, s.status]));
  assert.equal(statuses.a, STEP_STATUS.CANCELLED);
  assert.equal(statuses.b, STEP_STATUS.CANCELLED);
});

test('cancellation aborts an in-flight LLM call via AbortSignal', async () => {
  let sawAbort = false;
  const handler = async (ctx) => {
    await new Promise((resolve, reject) => {
      ctx.signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')); }, { once: true });
    });
  };
  const repos = createMemoryRepos();
  const logger = createLogger({ executions: repos.executions, executionSteps: repos.executionSteps, hub: createHub() });
  const execution = repos.executions.create({ orgId: ORG, projectId: 'p1', workflowId: 'wf_sig', status: 'queued' });
  const engine = new ExecutionEngine({
    workflow: { id: 'wf_sig', name: 'signal', nodes: [{ id: 'a', type: 'agent', name: 'A', config: {}, dependsOn: [] }] },
    execution,
    logger,
    injections: { orgId: ORG },
    options: { handlers: { agent: handler } },
  });
  const runPromise = engine.run();
  await new Promise((r) => setTimeout(r, 30));
  engine.cancel();
  const final = await runPromise;
  assert.equal(final.status, EXECUTION_STATUS.CANCELLED);
  assert.equal(sawAbort, true, 'handler received the abort signal');
});

// ---------------------------------------------------------------------------
// SSE hub / logger events
// ---------------------------------------------------------------------------

test('the logger broadcasts execution and step events to hub subscribers', async () => {
  const events = [];
  const hub = createHub();
  const repos = createMemoryRepos();
  const logger = createLogger({ executions: repos.executions, executionSteps: repos.executionSteps, hub });
  const execution = repos.executions.create({ orgId: ORG, projectId: 'p1', workflowId: 'wf_hub', status: 'queued' });
  hub.subscribe(execution.id, (e) => events.push(e));
  const engine = new ExecutionEngine({
    workflow: {
      id: 'wf_hub', name: 'hub', nodes: [
        { id: 'a', type: 'agent', name: 'A', config: {}, dependsOn: [] },
        { id: 'b', type: 'output', name: 'B', config: { targets: [] }, dependsOn: ['a'] },
      ],
    },
    execution,
    logger,
    injections: { orgId: ORG },
    options: { handlers: { agent: async () => 'ok' } },
  });
  const final = await engine.run();
  assert.equal(final.status, EXECUTION_STATUS.SUCCEEDED);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('execution'), 'execution status events emitted');
  assert.ok(types.includes('step'), 'step events emitted');
  assert.ok(events.filter((e) => e.type === 'execution').some((e) => e.data.status === EXECUTION_STATUS.SUCCEEDED));
});
