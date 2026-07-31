import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectService, AppError } from '../src/application/projectService.js';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';

function svc() {
  return new ProjectService(createMemoryRepos());
}

test('createProject rejects an empty prompt', () => {
  assert.throws(() => svc().createProject('  '), (e) => e instanceof AppError && e.code === 'INVALID_PROMPT');
});

test('full happy path: create -> grill -> answer -> scaffold', () => {
  const s = svc();
  const p = s.createProject('summarise my emails');
  assert.ok(p.id);

  const grill1 = s.grill(p.id);
  assert.equal(grill1.ready, false);
  assert.ok(grill1.questions.length > 0);

  s.answer(p.id, {
    'goal.outcome': 'a daily digest',
    'inputs.source': 'gmail inbox',
    'outputs.shape': 'markdown email',
    'success.measure': 'no urgent email missed',
  });

  const grill2 = s.grill(p.id);
  assert.equal(grill2.ready, true);

  const wf = s.scaffoldWorkflow(p.id);
  assert.ok(wf.nodes.length >= 3);
  assert.equal(wf.nodes[0].type, 'input');
  assert.equal(wf.nodes.at(-1).type, 'output');
});

test('scaffold refuses when spec is not ready, but force overrides', () => {
  const s = svc();
  const p = s.createProject('do something vague');
  assert.throws(() => s.scaffoldWorkflow(p.id), (e) => e.code === 'SPEC_NOT_READY' && e.status === 409);
  const forced = s.scaffoldWorkflow(p.id, { force: true });
  assert.ok(forced.nodes.length >= 2);
});

test('saveWorkflow validates invariants', () => {
  const s = svc();
  const p = s.createProject('x that produces y from z with success when correct');
  const invalid = { id: 'w', name: 'bad', nodes: [{ id: 'n', type: 'nope', name: 'n', dependsOn: [] }] };
  assert.throws(() => s.saveWorkflow(p.id, invalid), (e) => e.code === 'INVALID_WORKFLOW' && e.status === 422);

  const valid = { id: 'w', name: 'ok', nodes: [{ id: 'n', type: 'input', name: 'n', dependsOn: [] }] };
  const saved = s.saveWorkflow(p.id, valid);
  assert.equal(saved.id, 'w');
  assert.deepEqual(s.getWorkflow(p.id), saved);
});

test('getProject on unknown id throws 404', () => {
  assert.throws(() => svc().getProject('nope'), (e) => e.status === 404);
});

test('answers accumulate across calls', () => {
  const s = svc();
  const p = s.createProject('build a report');
  s.answer(p.id, { 'goal.outcome': 'a report' });
  const after = s.answer(p.id, { 'inputs.source': 'a csv' });
  assert.equal(after.answers['goal.outcome'], 'a report');
  assert.equal(after.answers['inputs.source'], 'a csv');
});
