import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpec, suggestNodes } from '../src/domain/spec/specBuilder.js';
import { validateWorkflow } from '../src/domain/workflow/validateWorkflow.js';
import { topoSort } from '../src/domain/workflow/topoSort.js';
import { NODE_TYPES } from '../src/domain/workflow/workflow.js';

/** A fully-populated spec covering every dimension. */
function fullSpec() {
  return {
    goal: 'build a weekly newsletter from my starred repos',
    why: 'keep up with the ecosystem without manual effort',
    inputs: ['github starred repos', 'my reading list'],
    outputs: ['markdown digest', 'email draft'],
    constraints: ['only public repos', 'max 10 items', 'no paid tools'],
    successCriteria: ['every starred repo appears once', 'digest fits one screen'],
    edgeCases: ['repo archived', 'starred repo deleted', 'duplicate repos'],
    ready: true,
    openQuestions: [],
  };
}

/** A bare-bones spec with only a goal — the minimal valid spec. */
function minimalSpec() {
  return { goal: 'do a thing', inputs: [], outputs: [], constraints: [], successCriteria: [], edgeCases: [] };
}

test('suggestNodes maps every spec dimension to the right node', () => {
  const spec = fullSpec();
  const nodes = suggestNodes(spec);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  // input node collects the sources
  assert.equal(byId['input.collect'].type, 'input');
  assert.deepEqual(byId['input.collect'].config.sources, spec.inputs);

  // the goal becomes the main agent node
  assert.equal(byId['agent.goal'].type, 'agent');
  assert.equal(byId['agent.goal'].config.objective, spec.goal);

  // constraints become a constraint-checker tool
  assert.equal(byId['tool.constraints'].type, 'tool');
  assert.deepEqual(byId['tool.constraints'].config.constraints, spec.constraints);

  // edge cases become an error-handling branch
  assert.equal(byId['branch.edgeCases'].type, 'branch');
  assert.deepEqual(byId['branch.edgeCases'].config.cases, spec.edgeCases);

  // success criteria become a validation tool
  assert.equal(byId['tool.validation'].type, 'tool');
  assert.deepEqual(byId['tool.validation'].config.criteria, spec.successCriteria);

  // outputs become the output node
  assert.equal(byId['output.deliver'].type, 'output');
  assert.deepEqual(byId['output.deliver'].config.targets, spec.outputs);
});

test('suggestNodes produces 3-7 nodes for any spec', () => {
  const specs = [
    minimalSpec(),
    fullSpec(),
    { goal: 'x', inputs: ['a'], outputs: ['b'], constraints: [], successCriteria: [], edgeCases: [] },
    { ...fullSpec(), inputs: [], outputs: [] },
    { goal: '', inputs: ['a'], outputs: ['b'], constraints: ['c'], successCriteria: ['d'], edgeCases: ['e'] },
  ];
  for (const spec of specs) {
    const count = suggestNodes(spec).length;
    assert.ok(count >= 3 && count <= 7, `expected 3-7 nodes, got ${count} for ${JSON.stringify(spec)}`);
  }
});

test('minimal spec yields exactly input -> agent -> output', () => {
  const nodes = suggestNodes(minimalSpec());
  assert.equal(nodes.length, 3);
  assert.deepEqual(
    nodes.map((n) => [n.id, n.type]),
    [
      ['input.collect', 'input'],
      ['agent.goal', 'agent'],
      ['output.deliver', 'output'],
    ],
  );
  assert.deepEqual(nodes[0].dependsOn, []);
  assert.deepEqual(nodes[1].dependsOn, ['input.collect']);
  assert.deepEqual(nodes[2].dependsOn, ['agent.goal']);
});

test('empty dimensions are skipped, full spec yields all five node types', () => {
  const sparse = suggestNodes({ ...fullSpec(), constraints: [], edgeCases: [], successCriteria: [] });
  assert.deepEqual(
    sparse.map((n) => n.id),
    ['input.collect', 'agent.goal', 'output.deliver'],
  );

  const full = suggestNodes(fullSpec());
  assert.equal(full.length, 6);
  assert.deepEqual(
    full.map((n) => n.id),
    ['input.collect', 'agent.goal', 'tool.constraints', 'branch.edgeCases', 'tool.validation', 'output.deliver'],
  );
  assert.deepEqual(new Set(full.map((n) => n.type)), new Set(NODE_TYPES));
});

test('every node has the required shape and a <dimension>.<specific> id', () => {
  for (const node of suggestNodes(fullSpec())) {
    assert.equal(typeof node.id, 'string');
    assert.match(node.id, /^[a-z]+\.[a-zA-Z]+$/, `id "${node.id}" is not <dimension>.<specific>`);
    assert.ok(NODE_TYPES.includes(node.type), `unknown type ${node.type}`);
    assert.equal(typeof node.name, 'string');
    assert.ok(node.name.length > 0);
    assert.equal(typeof node.config, 'object');
    assert.ok(Array.isArray(node.dependsOn), 'dependsOn must be an array');
  }
});

test('suggested nodes form a valid acyclic DAG with output downstream of agent', () => {
  const nodes = suggestNodes(fullSpec());
  const workflow = { id: 'wf_test', name: 'test', nodes };

  const result = validateWorkflow(workflow);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(topoSort(workflow).ok, true);

  // every dependsOn id resolves to a node that appears earlier in the chain
  const seen = new Set();
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      assert.ok(seen.has(dep), `node ${node.id} depends on unseen node ${dep}`);
    }
    seen.add(node.id);
  }

  // output sits at the end of the chain, transitively downstream of the agent
  const output = nodes.at(-1);
  assert.equal(output.type, 'output');
  assert.ok(transitivelyDependsOn(output.id, 'agent.goal', nodes), 'output must depend on the agent');
});

test('suggestNodes is deterministic for the same spec', () => {
  const spec = fullSpec();
  assert.deepEqual(suggestNodes(spec), suggestNodes(spec));
  // repeated calls do not accumulate state
  assert.deepEqual(suggestNodes(spec), suggestNodes(spec));
});

test('node configs are copies — mutating them does not corrupt the spec', () => {
  const spec = fullSpec();
  const [first] = suggestNodes(spec);
  first.config.sources.push('hacked');
  assert.deepEqual(spec.inputs, fullSpec().inputs);
});

test('a partial or undefined spec does not throw', () => {
  assert.equal(suggestNodes(undefined).length, 3);
  assert.equal(suggestNodes({}).length, 3);
  assert.equal(suggestNodes({ goal: 'only a goal' }).length, 3);
});

/** Depth-first search: does `fromId` transitively depend on `targetId`? */
function transitivelyDependsOn(fromId, targetId, nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stack = [...(byId.get(fromId)?.dependsOn ?? [])];
  const visited = new Set();
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === targetId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
}

test('buildSpec output feeds suggestNodes into a scaffoldable workflow', () => {
  const spec = buildSpec('summarise my emails', {
    'goal.outcome': 'a daily digest',
    'inputs.source': 'gmail inbox',
    'outputs.shape': 'markdown email',
    'success.measure': 'no urgent email missed',
  });
  assert.equal(spec.ready, true);
  const nodes = suggestNodes(spec);
  assert.equal(nodes[0].type, 'input');
  assert.equal(nodes.at(-1).type, 'output');
  assert.ok(nodes.length >= 3);
  assert.equal(validateWorkflow({ id: 'wf', name: 'x', nodes }).valid, true);
});
