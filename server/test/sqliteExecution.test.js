/**
 * sqliteExecution.test.js — Increment 5 schema + repos on REAL SQLite.
 *
 * Verifies migration 0009 applies cleanly on a fresh database file, the
 * executions / execution_steps / deployments repos persist and reload rows,
 * the org-scoping contract holds, and step rows cascade with their execution.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteRepos } from '../src/adapters/persistence/sqliteRepos.js';

const ORG = 'org-sql';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'sql-exec-'));
  const repos = createSqliteRepos(join(dir, 'test.db'));
  return { dir, repos };
}

test('migration 0009 creates the execution tables', () => {
  const { dir, repos } = freshDb();
  try {
    const tables = repos.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('executions', 'execution_steps', 'deployments')")
      .all()
      .map((r) => r.name)
      .sort();
    assert.deepEqual(tables, ['deployments', 'execution_steps', 'executions']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution + step rows persist, list newest-first, and cascade on delete', () => {
  const { dir, repos } = freshDb();
  try {
    const exec = repos.executions.create({ orgId: ORG, projectId: 'p1', workflowId: 'wf_1', status: 'running' });
    assert.equal(exec.status, 'running');
    repos.executionSteps.insert({
      orgId: ORG,
      executionId: exec.id,
      nodeId: 'a',
      nodeType: 'agent',
      status: 'running',
      inputData: { upstream: 1 },
    });
    const done = repos.executionSteps.update(ORG, repos.executionSteps.listByExecution(ORG, exec.id)[0].id, {
      status: 'success',
      outputData: { ok: true },
      durationMs: 12,
    });
    assert.equal(done.status, 'success');
    assert.equal(done.outputData.ok, true);

    const exec2 = repos.executions.create({ orgId: ORG, projectId: 'p1', workflowId: 'wf_1' });
    const list = repos.executions.listByProject(ORG, 'p1');
    assert.equal(list.length, 2);
    assert.equal(list[0].id, exec2.id, 'newest first');
    assert.equal(repos.executions.latestForProject(ORG, 'p1').id, exec2.id);

    // Update the execution row.
    const finished = repos.executions.update(ORG, exec.id, { status: 'succeeded', durationMs: 99 });
    assert.equal(finished.status, 'succeeded');

    // Org scoping: another org sees nothing.
    assert.equal(repos.executions.get('org-other', exec.id), null);
    assert.equal(repos.executionSteps.listByExecution('org-other', exec.id).length, 0);

    // Cascade: deleting… the adapter has no execution delete port, but the FK
    // is declared; verify the constraint exists.
    const fk = repos.db.prepare('PRAGMA foreign_key_list(execution_steps)').all();
    assert.ok(fk.some((r) => r.table === 'executions' && r.on_delete === 'CASCADE'), 'step rows cascade with execution');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deployments persist with config JSON and URLs', () => {
  const { dir, repos } = freshDb();
  try {
    const dep = repos.deployments.create({
      orgId: ORG,
      projectId: 'p1',
      platform: 'cloudflare',
      status: 'dry_run',
      config: { 'wrangler.toml': 'name = "x"' },
      url: 'https://x.workers.dev',
    });
    const reloaded = repos.deployments.get(ORG, dep.id);
    assert.equal(reloaded.platform, 'cloudflare');
    assert.equal(reloaded.config['wrangler.toml'], 'name = "x"');
    assert.equal(reloaded.url, 'https://x.workers.dev');

    const updated = repos.deployments.update(ORG, dep.id, { status: 'deployed' });
    assert.equal(updated.status, 'deployed');
    assert.equal(repos.deployments.listByProject(ORG, 'p1').length, 1);
    assert.equal(repos.deployments.listByProject('org-other', 'p1').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
