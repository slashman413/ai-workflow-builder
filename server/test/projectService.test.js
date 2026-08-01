import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectService, AppError } from '../src/application/projectService.js';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';

const ORG = 'org_test';

function svc() {
  return new ProjectService(createMemoryRepos());
}

test('createProject rejects an empty prompt', () => {
  assert.throws(() => svc().createProject(ORG, '  '), (e) => e instanceof AppError && e.code === 'INVALID_PROMPT');
});

test('services reject a missing orgId (defense in depth)', () => {
  assert.throws(() => svc().createProject(undefined, 'build a thing'), (e) => e.code === 'ORG_REQUIRED' && e.status === 403);
  assert.throws(() => svc().listProjects(''), (e) => e.code === 'ORG_REQUIRED');
});

test('full happy path: create -> grill -> answer -> scaffold', () => {
  const s = svc();
  const p = s.createProject(ORG, 'summarise my emails');
  assert.ok(p.id);
  assert.equal(p.orgId, ORG);

  const grill1 = s.grill(ORG, p.id);
  assert.equal(grill1.ready, false);
  assert.ok(grill1.questions.length > 0);

  s.answer(ORG, p.id, {
    'goal.outcome': 'a daily digest',
    'inputs.source': 'gmail inbox',
    'outputs.shape': 'markdown email',
    'success.measure': 'no urgent email missed',
  });

  const grill2 = s.grill(ORG, p.id);
  assert.equal(grill2.ready, true);

  const wf = s.scaffoldWorkflow(ORG, p.id);
  assert.ok(wf.nodes.length >= 3);
  assert.equal(wf.nodes[0].type, 'input');
  assert.equal(wf.nodes.at(-1).type, 'output');
});

test('every answer round appends an org-scoped grill session', () => {
  const repos = createMemoryRepos();
  const s = new ProjectService(repos);
  const p = s.createProject(ORG, 'build a report');
  assert.equal(repos.grillSessions.listByProject(ORG, p.id).length, 0);

  s.answer(ORG, p.id, { 'goal.outcome': 'a report' });
  s.answer(ORG, p.id, { 'inputs.source': 'a csv' });

  const sessions = repos.grillSessions.listByProject(ORG, p.id);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].round, 1);
  assert.equal(sessions[1].round, 2);
  assert.equal(sessions[0].orgId, ORG);
  assert.equal(sessions[1].answers['inputs.source'], 'a csv');
});

test('grill sessions are invisible to other orgs', () => {
  const repos = createMemoryRepos();
  const s = new ProjectService(repos);
  const p = s.createProject(ORG, 'build a report');
  s.answer(ORG, p.id, { 'goal.outcome': 'a report' });
  assert.equal(repos.grillSessions.listByProject('org_other', p.id).length, 0);
  assert.equal(repos.grillSessions.getLatest('org_other', p.id), null);
});

test('scaffold refuses when spec is not ready, but force overrides', () => {
  const s = svc();
  const p = s.createProject(ORG, 'do something vague');
  assert.throws(() => s.scaffoldWorkflow(ORG, p.id), (e) => e.code === 'SPEC_NOT_READY' && e.status === 409);
  const forced = s.scaffoldWorkflow(ORG, p.id, { force: true });
  assert.ok(forced.nodes.length >= 2);
});

test('saveWorkflow validates invariants', () => {
  const s = svc();
  const p = s.createProject(ORG, 'x that produces y from z with success when correct');
  const invalid = { id: 'w', name: 'bad', nodes: [{ id: 'n', type: 'nope', name: 'n', dependsOn: [] }] };
  assert.throws(() => s.saveWorkflow(ORG, p.id, invalid), (e) => e.code === 'INVALID_WORKFLOW' && e.status === 422);

  const valid = { id: 'w', name: 'ok', nodes: [{ id: 'n', type: 'input', name: 'n', dependsOn: [] }] };
  const saved = s.saveWorkflow(ORG, p.id, valid);
  assert.equal(saved.id, 'w');
  assert.deepEqual(s.getWorkflow(ORG, p.id), saved);
});

test('getProject on unknown id throws 404', () => {
  assert.throws(() => svc().getProject(ORG, 'nope'), (e) => e.status === 404);
});

test('answers accumulate across calls', () => {
  const s = svc();
  const p = s.createProject(ORG, 'build a report');
  s.answer(ORG, p.id, { 'goal.outcome': 'a report' });
  const after = s.answer(ORG, p.id, { 'inputs.source': 'a csv' });
  assert.equal(after.answers['goal.outcome'], 'a report');
  assert.equal(after.answers['inputs.source'], 'a csv');
});
