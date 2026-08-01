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

maybe('SQLite repo round-trips a project and its workflow, org-scoped', () => {
  const repos = createSqliteRepos(':memory:');
  const s = new ProjectService(repos);

  const p = s.createProject('org_a', 'produce a digest from my inbox, correct when nothing urgent is missed');
  const fetched = s.getProject('org_a', p.id);
  assert.equal(fetched.prompt, p.prompt);
  assert.equal(fetched.orgId, 'org_a');

  s.answer('org_a', p.id, { 'goal.outcome': 'digest', 'inputs.source': 'inbox', 'outputs.shape': 'md', 'success.measure': 'complete' });
  const wf = s.scaffoldWorkflow('org_a', p.id);
  assert.deepEqual(s.getWorkflow('org_a', p.id), wf);

  assert.equal(s.listProjects('org_a').length, 1);
  s.deleteProject('org_a', p.id);
  assert.equal(s.listProjects('org_a').length, 0);
  // ON DELETE CASCADE should have removed the workflow too.
  assert.equal(repos.workflows.getByProject('org_a', p.id), null);
});

maybe('SQLite migrations apply the tenant-scoping and vault schema', () => {
  const { db } = createSqliteRepos(':memory:');
  const columns = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  assert.ok(columns.includes('org_id'), 'projects.org_id exists');
  const wfColumns = db.prepare('PRAGMA table_info(workflows)').all().map((c) => c.name);
  assert.ok(wfColumns.includes('org_id'), 'workflows.org_id exists');
  const gsColumns = db.prepare('PRAGMA table_info(grill_sessions)').all().map((c) => c.name);
  assert.ok(gsColumns.includes('org_id'), 'grill_sessions.org_id exists');
  const vkColumns = db.prepare('PRAGMA table_info(vault_keys)').all().map((c) => c.name);
  assert.ok(vkColumns.includes('wrapped_key') && vkColumns.includes('wrapped_dek'), 'vault_keys is present');
});

maybe('SQLite upsert refuses to overwrite another org workflow', () => {
  const { projects, workflows } = createSqliteRepos(':memory:');
  const pA = projects.create({ orgId: 'org_a', prompt: 'A', answers: {} });
  workflows.save('org_a', pA.id, { id: 'wf', name: 'A wf', nodes: [] });
  // Org B knows the project id but must not be able to overwrite A's row.
  const result = workflows.save('org_b', pA.id, { id: 'wf', name: 'B wf', nodes: [] });
  assert.equal(result, null);
  const wfA = workflows.getByProject('org_a', pA.id);
  assert.equal(wfA.name, 'A wf');
});
