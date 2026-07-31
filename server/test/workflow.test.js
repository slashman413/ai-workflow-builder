import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow } from '../src/domain/workflow/validateWorkflow.js';
import { topoSort } from '../src/domain/workflow/topoSort.js';
import { edgesOf, rootNodes, leafNodes } from '../src/domain/workflow/workflow.js';

const linear = {
  id: 'wf1',
  name: 'linear',
  nodes: [
    { id: 'a', type: 'input', name: 'A', dependsOn: [] },
    { id: 'b', type: 'agent', name: 'B', dependsOn: ['a'] },
    { id: 'c', type: 'output', name: 'C', dependsOn: ['b'] },
  ],
};

test('a valid linear workflow passes validation', () => {
  const { valid, errors } = validateWorkflow(linear);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('topoSort returns a valid, deterministic order', () => {
  const r = topoSort(linear);
  assert.equal(r.ok, true);
  assert.deepEqual(r.order, ['a', 'b', 'c']);
});

test('edges, roots and leaves are derived from dependsOn', () => {
  assert.deepEqual(edgesOf(linear), [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ]);
  assert.deepEqual(rootNodes(linear).map((n) => n.id), ['a']);
  assert.deepEqual(leafNodes(linear).map((n) => n.id), ['c']);
});

test('a cycle is detected and reported', () => {
  const cyclic = {
    id: 'wf2',
    name: 'cyclic',
    nodes: [
      { id: 'a', type: 'agent', name: 'A', dependsOn: ['c'] },
      { id: 'b', type: 'agent', name: 'B', dependsOn: ['a'] },
      { id: 'c', type: 'agent', name: 'C', dependsOn: ['b'] },
    ],
  };
  const { valid, errors } = validateWorkflow(cyclic);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.code === 'CYCLE'));
  assert.equal(topoSort(cyclic).ok, false);
});

test('duplicate ids are rejected', () => {
  const dup = {
    id: 'wf', name: 'dup',
    nodes: [
      { id: 'a', type: 'input', name: 'A', dependsOn: [] },
      { id: 'a', type: 'output', name: 'A2', dependsOn: [] },
    ],
  };
  const { valid, errors } = validateWorkflow(dup);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.code === 'DUPLICATE_ID'));
});

test('dangling and self dependencies are rejected', () => {
  const bad = {
    id: 'wf', name: 'bad',
    nodes: [
      { id: 'a', type: 'agent', name: 'A', dependsOn: ['ghost'] },
      { id: 'b', type: 'agent', name: 'B', dependsOn: ['b'] },
    ],
  };
  const { errors } = validateWorkflow(bad);
  assert.ok(errors.some((e) => e.code === 'DANGLING_DEPENDENCY'));
  assert.ok(errors.some((e) => e.code === 'SELF_DEPENDENCY'));
});

test('unknown node type and empty workflow are rejected', () => {
  assert.ok(validateWorkflow({ nodes: [] }).errors.some((e) => e.code === 'EMPTY'));
  const badType = { nodes: [{ id: 'a', type: 'wizard', name: 'A', dependsOn: [] }] };
  assert.ok(validateWorkflow(badType).errors.some((e) => e.code === 'BAD_TYPE'));
});
