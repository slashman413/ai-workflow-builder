import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeWorkflow } from '../src/domain/executor/executor.js';
import { defaultHandlers, handlesError, checkRule, buildPrompt } from '../src/domain/executor/handlers.js';
import { suggestNodes } from '../src/domain/spec/specBuilder.js';

/* ---------------------------------------------------------------------------
 * Fixtures & helpers
 * ------------------------------------------------------------------------ */

function linearWorkflow() {
  return {
    id: 'wf_linear',
    name: 'linear',
    nodes: [
      { id: 'a', type: 'input', name: 'A', dependsOn: [] },
      { id: 'b', type: 'agent', name: 'B', dependsOn: ['a'] },
      { id: 'c', type: 'output', name: 'C', dependsOn: ['b'] },
    ],
  };
}

function fakeResponse({ ok = true, status = 200, json, text } = {}) {
  return {
    ok,
    status,
    json: json ?? (async () => ({})),
    text: text ?? (async () => ''),
  };
}

/** Swap global fetch for the duration of fn, then restore it. */
async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** A spec covering every dimension, like codegen.test.js uses. */
function sampleSpec() {
  return {
    goal: 'build a weekly newsletter from my starred repos',
    why: 'keep up with the ecosystem without manual effort',
    inputs: ['github starred repos', 'my reading list'],
    outputs: ['markdown digest', 'email draft'],
    constraints: ['only public repos', 'max 10 items'],
    successCriteria: ['every starred repo appears once'],
    edgeCases: ['repo archived', 'duplicate repos'],
    ready: true,
    openQuestions: [],
  };
}

function tmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'executor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ---------------------------------------------------------------------------
 * Ordering & context threading
 * ------------------------------------------------------------------------ */

test('executor runs a linear workflow in topological order, threading outputs', async () => {
  const calls = [];
  const result = await executeWorkflow({
    workflow: linearWorkflow(),
    handlers: {
      input: async (ctx, node) => {
        calls.push(node.id);
        return { raw: 'input-data' };
      },
      agent: async (ctx, node) => {
        calls.push(node.id);
        assert.deepEqual(ctx.get('a'), { raw: 'input-data' }); // sees upstream output
        return 'agent-result';
      },
      output: async (ctx, node) => {
        calls.push(node.id);
        assert.equal(ctx.get('b'), 'agent-result');
        return { saved: true };
      },
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(
    result.steps.map((s) => [s.id, s.status]),
    [['a', 'success'], ['b', 'success'], ['c', 'success']],
  );
  assert.equal(result.steps[0].output.raw, 'input-data');
  assert.equal(result.steps[1].output, 'agent-result');
  assert.ok(result.steps.every((s) => typeof s.duration === 'number' && s.duration >= 0));
  assert.deepEqual(result.errors, []);
  assert.equal(result.error, null);
});

test('executor honours a DAG: dependents run only after all dependencies', async () => {
  const dag = {
    id: 'wf_dag',
    name: 'dag',
    nodes: [
      { id: 'a', type: 'input', name: 'A', dependsOn: [] },
      { id: 'b', type: 'tool', name: 'B', dependsOn: ['a'] },
      { id: 'c', type: 'tool', name: 'C', dependsOn: ['a'] },
      { id: 'd', type: 'output', name: 'D', dependsOn: ['b', 'c'] },
    ],
  };
  const calls = [];
  const result = await executeWorkflow({
    workflow: dag,
    handlers: {
      input: async (ctx, node) => (calls.push(node.id), `out-${node.id}`),
      tool: async (ctx, node) => {
        calls.push(node.id);
        assert.equal(ctx.get('a'), 'out-a');
        return { checked: node.id };
      },
      output: async (ctx, node) => {
        calls.push(node.id);
        assert.equal(ctx.get('b').checked, 'b');
        assert.equal(ctx.get('c').checked, 'c');
        return { done: true };
      },
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
  assert.deepEqual(result.steps.map((s) => s.id), ['a', 'b', 'c', 'd']);
});

test('handlers are pluggable per node type — partial overrides keep defaults', async () => {
  const workflow = linearWorkflow();
  // give the input node a source so the default input handler has work to do
  workflow.nodes[0] = { ...workflow.nodes[0], config: { sources: ['literal'] } };

  const result = await executeWorkflow({
    workflow,
    handlers: {
      agent: async (ctx) => `mocked:${ctx.get('a').literal}`,
    },
  });

  assert.equal(result.success, true);
  // input + output used the default handlers; agent was swapped.
  assert.deepEqual(result.steps[0].output, { literal: 'literal' }); // default input handler
  assert.equal(result.steps[1].output, 'mocked:literal');
  assert.deepEqual(result.steps[2].output, {}); // default output handler, no targets
});

test('env is passed through and merged over process.env', async () => {
  const result = await executeWorkflow({
    workflow: { id: 'wf_env', name: 'env', nodes: [{ id: 'a', type: 'agent', name: 'A', dependsOn: [] }] },
    env: { MY_FLAG: 'yes' },
    handlers: {
      agent: async (ctx) => {
        assert.equal(ctx.env.MY_FLAG, 'yes');
        assert.equal(typeof ctx.env.HOME, 'string'); // inherited from process.env
        return 'ok';
      },
    },
  });
  assert.equal(result.success, true);
});

/* ---------------------------------------------------------------------------
 * Error handling
 * ------------------------------------------------------------------------ */

test('a failing node is recovered by a branch that handles it; the run completes', async () => {
  const workflow = {
    id: 'wf_rec',
    name: 'recovery',
    nodes: [
      { id: 'fetch', type: 'input', name: 'Fetch', dependsOn: [], config: { sources: ['literal'] } },
      { id: 'analyze', type: 'agent', name: 'Analyze', dependsOn: ['fetch'] },
      { id: 'guard', type: 'branch', name: 'Guard', dependsOn: ['analyze'], config: { handles: ['analyze'] } },
      { id: 'report', type: 'output', name: 'Report', dependsOn: ['guard'] },
    ],
  };
  const result = await executeWorkflow({
    workflow,
    handlers: {
      input: async () => 'data',
      agent: async () => {
        throw new Error('boom');
      },
      output: async (ctx) => {
        // downstream sees the branch's error-handling report
        assert.ok(ctx.get('guard').handled.includes('analyze'));
        return { ok: true };
      },
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.errors, [{ nodeId: 'analyze', message: 'boom', handled: true }]);
  assert.deepEqual(
    result.steps.map((s) => [s.id, s.status]),
    [
      ['fetch', 'success'],
      ['analyze', 'error'],
      ['guard', 'success'],
      ['report', 'success'],
    ],
  );
  // The branch ran exactly once (as the error handler, not twice).
  assert.equal(result.steps.filter((s) => s.id === 'guard').length, 1);
  assert.deepEqual(result.steps[2].output.handled, ['analyze']);
});

test('a custom branch handler can read the error off the context', async () => {
  const workflow = {
    id: 'wf_ctx',
    name: 'ctx-errors',
    nodes: [
      { id: 'a', type: 'agent', name: 'A', dependsOn: [] },
      { id: 'guard', type: 'branch', name: 'G', dependsOn: ['a'], config: { onError: true } },
      { id: 'finish', type: 'output', name: 'F', dependsOn: ['guard'] },
    ],
  };
  const result = await executeWorkflow({
    workflow,
    handlers: {
      agent: async () => {
        throw new Error('kaput');
      },
      branch: async (ctx) => ({ caught: ctx.getError('a')?.message ?? null }),
      output: async () => ({ done: true }),
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.steps[1].output.caught, 'kaput');
  assert.equal(result.errors[0].handled, true);
});

test('an unhandled failure aborts the run and skips the remaining nodes', async () => {
  const workflow = {
    id: 'wf_abort',
    name: 'abort',
    nodes: [
      { id: 'fetch', type: 'input', name: 'Fetch', dependsOn: [], config: { sources: ['literal'] } },
      { id: 'analyze', type: 'agent', name: 'Analyze', dependsOn: ['fetch'] },
      { id: 'report', type: 'output', name: 'Report', dependsOn: ['analyze'] },
    ],
  };
  const result = await executeWorkflow({
    workflow,
    handlers: {
      input: async () => 'data',
      agent: async () => {
        throw new Error('boom');
      },
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.error, 'boom');
  assert.deepEqual(result.errors, [{ nodeId: 'analyze', message: 'boom', handled: false }]);
  assert.deepEqual(
    result.steps.map((s) => [s.id, s.status]),
    [
      ['fetch', 'success'],
      ['analyze', 'error'],
      ['report', 'skipped'],
    ],
  );
  assert.match(result.steps[2].error, /workflow aborted at "analyze"/);
});

test('a failed error-handler branch itself aborts the run', async () => {
  const workflow = {
    id: 'wf_badhandler',
    name: 'bad-handler',
    nodes: [
      { id: 'a', type: 'agent', name: 'A', dependsOn: [] },
      { id: 'guard', type: 'branch', name: 'G', dependsOn: ['a'], config: { handles: ['a'] } },
    ],
  };
  const result = await executeWorkflow({
    workflow,
    handlers: {
      agent: async () => {
        throw new Error('first failure');
      },
      branch: async () => {
        throw new Error('handler blew up');
      },
    },
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.nodeId === 'guard' && e.handled === false));
  assert.ok(result.errors.some((e) => e.nodeId === 'a' && e.handled === false));
});

test('invalid workflows are rejected before any node runs', async () => {
  const cyclic = {
    id: 'wf_cycle',
    name: 'cyclic',
    nodes: [
      { id: 'a', type: 'agent', name: 'A', dependsOn: ['c'] },
      { id: 'b', type: 'agent', name: 'B', dependsOn: ['a'] },
      { id: 'c', type: 'agent', name: 'C', dependsOn: ['b'] },
    ],
  };
  const result = await executeWorkflow({ workflow: cyclic });
  assert.equal(result.success, false);
  assert.deepEqual(result.steps, []);
  assert.match(result.error, /cycle/i);

  const unknownType = { id: 'wf', name: 'x', nodes: [{ id: 'a', type: 'wizard', name: 'A', dependsOn: [] }] };
  const bad = await executeWorkflow({ workflow: unknownType });
  assert.equal(bad.success, false);
  assert.match(bad.error, /validation failed/i);
});

/* ---------------------------------------------------------------------------
 * Default handlers — input / tool / branch / output
 * ------------------------------------------------------------------------ */

test('default input handler loads URLs, files and literals', async (t) => {
  const dir = tmpDir(t);
  const filePath = join(dir, 'input.txt');
  writeFileSync(filePath, 'file contents', 'utf8');

  const workflow = {
    id: 'wf_in',
    name: 'inputs',
    nodes: [
      {
        id: 'collect',
        type: 'input',
        name: 'Collect',
        dependsOn: [],
        config: { sources: ['https://example.com/data', filePath, 'plain literal'] },
      },
    ],
  };
  const result = await withFetch(async (url) => {
    assert.equal(url, 'https://example.com/data');
    return fakeResponse({ text: async () => 'remote data' });
  }, () => executeWorkflow({ workflow }));

  assert.equal(result.success, true);
  assert.deepEqual(result.steps[0].output, {
    'https://example.com/data': 'remote data',
    [filePath]: 'file contents',
    'plain literal': 'plain literal',
  });
});

test('default input handler honours user-mode values and rejects missing ones', async () => {
  const withValues = {
    id: 'wf_u1',
    name: 'user inputs',
    nodes: [
      {
        id: 'collect',
        type: 'input',
        name: 'Collect',
        dependsOn: [],
        config: { mode: 'user', sources: ['name', 'city'], values: { name: 'Wayne', city: 'Taipei' } },
      },
    ],
  };
  const ok = await executeWorkflow({ workflow: withValues });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.steps[0].output, { name: 'Wayne', city: 'Taipei' });

  const missing = await executeWorkflow({
    workflow: {
      id: 'wf_u2',
      name: 'missing value',
      nodes: [
        {
          id: 'collect',
          type: 'input',
          name: 'Collect',
          dependsOn: [],
          config: { mode: 'user', sources: ['name'], values: {} },
        },
      ],
    },
  });
  assert.equal(missing.success, false);
  assert.match(missing.error, /user input required for "name"/);
});

test('default tool handler checks constraints and criteria against context', async () => {
  const workflow = {
    id: 'wf_tool',
    name: 'tools',
    nodes: [
      { id: 'a', type: 'input', name: 'A', dependsOn: [], config: { sources: ['the quick brown fox jumps'] } },
      { id: 'b', type: 'tool', name: 'B', dependsOn: ['a'], config: { constraints: ['quick fox'] } },
      { id: 'c', type: 'tool', name: 'C', dependsOn: ['a'], config: { criteria: ['purple elephant'] } },
    ],
  };
  const result = await executeWorkflow({ workflow });
  assert.equal(result.success, true);
  assert.deepEqual(result.steps[1].output, { results: { 'quick fox': true }, passed: true });
  assert.deepEqual(result.steps[2].output, { results: { 'purple elephant': false }, passed: false });
});

test('default branch handler reports matching edge cases as warnings', async () => {
  const workflow = {
    id: 'wf_branch',
    name: 'branch',
    nodes: [
      { id: 'a', type: 'input', name: 'A', dependsOn: [], config: { sources: ['repo archived today'] } },
      { id: 'b', type: 'branch', name: 'B', dependsOn: ['a'], config: { cases: ['repo archived', 'quiet day'] } },
    ],
  };
  const result = await executeWorkflow({ workflow });
  assert.equal(result.success, true);
  assert.deepEqual(result.steps[1].output, {
    node_id: 'b',
    errors: [],
    warnings: ['edge case detected: repo archived'],
    handled: [],
  });
});

test('default output handler writes JSON files and email drafts', async (t) => {
  const dir = tmpDir(t);
  const workflow = {
    id: 'wf_out',
    name: 'outputs',
    nodes: [
      { id: 'a', type: 'input', name: 'A', dependsOn: [], config: { sources: ['hello world'] } },
      {
        id: 'deliver',
        type: 'output',
        name: 'Deliver',
        dependsOn: ['a'],
        config: { targets: ['markdown digest', 'person@example.com'], dir },
      },
    ],
  };
  const result = await executeWorkflow({ workflow });
  assert.equal(result.success, true);

  const jsonPath = join(dir, 'markdown-digest.json');
  const emlPath = join(dir, 'person-example-com.eml');
  assert.equal(result.steps[1].output['markdown digest'], `file written to ${jsonPath}`);
  assert.match(result.steps[1].output['person@example.com'], /email draft written to/);
  assert.match(readFileSync(jsonPath, 'utf8'), /hello world/);
  assert.match(readFileSync(emlPath, 'utf8'), /To: person@example.com/);
});

/* ---------------------------------------------------------------------------
 * Default handlers — agent (real API shape, fetch stubbed)
 * ------------------------------------------------------------------------ */

test('default agent handler calls the OpenAI API and returns the message content', async () => {
  const workflow = {
    id: 'wf_agent',
    name: 'agent',
    nodes: [
      { id: 'a', type: 'input', name: 'A', dependsOn: [], config: { sources: ['context data'] } },
      { id: 'b', type: 'agent', name: 'B', dependsOn: ['a'], config: { objective: 'summarize' } },
    ],
  };
  const result = await withFetch(async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[1].content, /Objective: summarize/);
    assert.match(body.messages[1].content, /context data/); // context threaded into prompt
    return fakeResponse({ json: async () => ({ choices: [{ message: { content: 'agent answer' } }] }) });
  }, () => executeWorkflow({ workflow, env: { OPENAI_API_KEY: 'test-key' } }));

  assert.equal(result.success, true);
  assert.equal(result.steps[1].output, 'agent answer');
});

test('default agent handler supports Anthropic via provider config', async () => {
  const workflow = {
    id: 'wf_anthropic',
    name: 'anthropic agent',
    nodes: [
      {
        id: 'a',
        type: 'agent',
        name: 'A',
        dependsOn: [],
        config: { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
      },
    ],
  };
  const result = await withFetch(async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], 'ankey');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'claude-3-5-haiku-latest');
    return fakeResponse({
      json: async () => ({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }),
    });
  }, () => executeWorkflow({ workflow, env: { ANTHROPIC_API_KEY: 'ankey' } }));

  assert.equal(result.success, true);
  assert.equal(result.steps[0].output, 'hello world');
});

test('default agent handler fails fast when the API key is missing', async () => {
  const workflow = {
    id: 'wf_nokey',
    name: 'no key',
    nodes: [{ id: 'a', type: 'agent', name: 'A', dependsOn: [] }],
  };
  const result = await executeWorkflow({ workflow, env: { OPENAI_API_KEY: '' } });
  assert.equal(result.success, false);
  assert.match(result.error, /OPENAI_API_KEY is not set/);
  assert.equal(result.steps[0].status, 'error');
});

/* ---------------------------------------------------------------------------
 * Full workflow with default handlers (spec-builder output, real shapes)
 * ------------------------------------------------------------------------ */

test('a full spec-built workflow executes end to end with default handlers', async (t) => {
  const dir = tmpDir(t);
  const workflow = {
    id: 'wf_newsletter',
    name: 'Newsletter digest',
    nodes: suggestNodes(sampleSpec()).map((n) =>
      n.id === 'output.deliver' ? { ...n, config: { ...n.config, dir } } : n,
    ),
  };

  const result = await withFetch(async (url) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    return fakeResponse({ json: async () => ({ choices: [{ message: { content: 'newsletter draft' } }] }) });
  }, () => executeWorkflow({ workflow, env: { OPENAI_API_KEY: 'test-key' } }));

  assert.equal(result.success, true);
  assert.equal(result.error, null);
  assert.deepEqual(
    result.steps.map((s) => [s.id, s.status]),
    [
      ['input.collect', 'success'],
      ['agent.goal', 'success'],
      ['tool.constraints', 'success'],
      ['branch.edgeCases', 'success'],
      ['tool.validation', 'success'],
      ['output.deliver', 'success'],
    ],
  );
  assert.equal(result.steps[1].output, 'newsletter draft'); // agent output threaded
  assert.deepEqual(Object.keys(result.steps[2].output.results), ['only public repos', 'max 10 items']);
  assert.equal(typeof result.steps[2].output.passed, 'boolean');
  assert.equal(result.steps[3].output.node_id, 'branch.edgeCases');

  // output node wrote the artifacts
  assert.ok(readFileSync(join(dir, 'markdown-digest.json'), 'utf8').includes('newsletter draft'));
  assert.ok(readFileSync(join(dir, 'email-draft.json'), 'utf8').includes('newsletter draft'));
});

/* ---------------------------------------------------------------------------
 * Small unit checks on exported helpers
 * ------------------------------------------------------------------------ */

test('handlesError recognises list, wildcard and onError declarations', () => {
  assert.equal(handlesError({ config: { handles: ['a', 'b'] } }, 'a'), true);
  assert.equal(handlesError({ config: { handles: ['a'] } }, 'z'), false);
  assert.equal(handlesError({ config: { handles: ['*'] } }, 'z'), true);
  assert.equal(handlesError({ config: { onError: true } }, 'z'), true);
  assert.equal(handlesError({ config: { cases: [] } }, 'z'), false);
  assert.equal(handlesError({}, 'z'), false);
});

test('checkRule matches significant words, ignoring short ones', () => {
  assert.equal(checkRule('quick fox', 'the quick brown fox'), true);
  assert.equal(checkRule('public repos', 'only public repos allowed'), true);
  assert.equal(checkRule('purple elephant', 'the quick brown fox'), false);
  assert.equal(checkRule('a b c', 'anything at all'), true); // no significant words
});

test('buildPrompt composes objective and context', () => {
  const prompt = buildPrompt('summarize', '{"a":1}');
  assert.match(prompt, /Objective: summarize/);
  assert.match(prompt, /\{"a":1\}/);
});

test('default handlers cover every declared node type', () => {
  for (const type of ['input', 'agent', 'tool', 'branch', 'output']) {
    assert.equal(typeof defaultHandlers[type], 'function', `default handler for ${type}`);
  }
});
