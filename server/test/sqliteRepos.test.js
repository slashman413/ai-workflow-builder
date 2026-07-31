import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectService } from '../src/application/projectService.js';

// node:sqlite ships as an experimental built-in. Skip gracefully on runtimes
// that don't expose it so the rest of the suite still runs.
let createSqliteRepos;
try {
  ({ createSqliteRepos } = await import('../src/adapters/persistence/sqliteRepos.js'));
} catch {
  createSqliteRepos = null;
}

const maybe = createSqliteRepos ? test : test.skip;

maybe('SQLite repo round-trips a project and its workflow', () => {
  const { projects, workflows } = createSqliteRepos(':memory:');
  const s = new ProjectService({ projects, workflows });

  const p = s.createProject('produce a digest from my inbox, correct when nothing urgent is missed');
  const fetched = s.getProject(p.id);
  assert.equal(fetched.prompt, p.prompt);

  s.answer(p.id, { 'goal.outcome': 'digest', 'inputs.source': 'inbox', 'outputs.shape': 'md', 'success.measure': 'complete' });
  const wf = s.scaffoldWorkflow(p.id);
  assert.deepEqual(s.getWorkflow(p.id), wf);

  assert.equal(s.listProjects().length, 1);
  s.deleteProject(p.id);
  assert.equal(s.listProjects().length, 0);
  // ON DELETE CASCADE should have removed the workflow too.
  assert.equal(workflows.getByProject(p.id), null);
});
