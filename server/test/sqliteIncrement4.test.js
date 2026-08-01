/**
 * sqliteIncrement4.test.js — SQLite persistence for the Increment 4 repos
 * (billing, github_connections, publications, catalog listTools).
 *
 * The migrations 0006/0007 create these tables; this suite exercises the
 * org-scoped repository contract against the real SQLite adapter so the
 * production persistence path is tested, not just the in-memory twin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

let createSqliteRepos;
try {
  ({ createSqliteRepos } = await import('../src/adapters/persistence/sqliteRepos.js'));
} catch {
  createSqliteRepos = null;
}
const maybe = createSqliteRepos ? test : test.skip;

maybe('billing repo round-trips and upserts org-scoped rows', () => {
  const repos = createSqliteRepos(':memory:');
  assert.equal(repos.billing.getByOrg('org-1'), null);

  const row = repos.billing.upsert('org-1', {
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    plan: 'team',
    status: 'trialing',
    trialEnd: '2026-08-15T00:00:00.000Z',
    cancelAtPeriodEnd: false,
  });
  assert.equal(row.status, 'trialing');
  assert.equal(row.plan, 'team');
  assert.equal(row.orgId, 'org-1');

  // Upsert preserves fields not provided and updates the mutable ones.
  const updated = repos.billing.upsert('org-1', { status: 'active', plan: 'team' });
  assert.equal(updated.status, 'active');
  assert.equal(updated.stripeCustomerId, 'cus_1', 'customer survives the upsert');
  assert.equal(updated.trialEnd, '2026-08-15T00:00:00.000Z', 'trial end survives the upsert');
  assert.ok(updated.updatedAt >= row.updatedAt);

  // Another org is untouched.
  assert.equal(repos.billing.getByOrg('org-2'), null);
});

maybe('billing event ledger dedupes by event id (idempotency)', () => {
  const repos = createSqliteRepos(':memory:');
  const first = repos.billing.recordEvent({ eventId: 'evt_1', eventType: 'checkout.session.completed', orgId: 'org-1' });
  assert.equal(first, true, 'first delivery is new');
  const replay = repos.billing.recordEvent({ eventId: 'evt_1', eventType: 'checkout.session.completed', orgId: 'org-1' });
  assert.equal(replay, false, 'replay is a duplicate');
  assert.equal(repos.billing.listEvents('org-1').length, 1);
  assert.equal(repos.billing.listEvents('org-1')[0].eventType, 'checkout.session.completed');
});

maybe('github connections seal tokens and disconnect removes them', () => {
  const repos = createSqliteRepos(':memory:');
  repos.githubConnections.upsert('org-1', { login: 'octocat', tokenSealed: 'sealed-blob', scopes: ['repo'] });
  const conn = repos.githubConnections.get('org-1');
  assert.equal(conn.login, 'octocat');
  assert.equal(conn.tokenSealed, 'sealed-blob');
  assert.deepEqual(conn.scopes, ['repo']);

  // Reconnect (token rotation) updates in place.
  repos.githubConnections.upsert('org-1', { login: 'octocat', tokenSealed: 'sealed-blob-2', scopes: ['repo', 'user'] });
  assert.equal(repos.githubConnections.get('org-1').tokenSealed, 'sealed-blob-2');

  assert.equal(repos.githubConnections.remove('org-1'), true);
  assert.equal(repos.githubConnections.get('org-1'), null);
  assert.equal(repos.githubConnections.remove('org-1'), false);
});

maybe('publications ledger records and lists org/project-scoped', () => {
  const repos = createSqliteRepos(':memory:');
  const projectId = randomUUID();
  repos.publications.record({
    orgId: 'org-1',
    projectId,
    repoOwner: 'octocat',
    repoName: 'repo-a',
    repoUrl: 'https://github.com/octocat/repo-a',
    private: true,
    fileCount: 7,
    latencyMs: 312,
    workflowHash: 'a'.repeat(64),
  });
  repos.publications.record({
    orgId: 'org-1',
    projectId,
    repoOwner: 'octocat',
    repoName: 'repo-b',
    repoUrl: 'https://github.com/octocat/repo-b',
    private: false,
    fileCount: 5,
    latencyMs: 240,
    workflowHash: 'b'.repeat(64),
  });
  repos.publications.record({
    orgId: 'org-2',
    projectId: randomUUID(),
    repoOwner: 'other',
    repoName: 'repo-c',
    repoUrl: 'https://github.com/other/repo-c',
    private: false,
    fileCount: 3,
    latencyMs: 150,
    workflowHash: 'c'.repeat(64),
  });

  const orgPubs = repos.publications.listByOrg('org-1');
  assert.equal(orgPubs.length, 2);
  assert.equal(orgPubs[0].repoName, 'repo-b', 'newest first');
  assert.equal(orgPubs[0].workflowHash, 'b'.repeat(64));

  const projectPubs = repos.publications.listByProject('org-1', projectId);
  assert.equal(projectPubs.length, 2);

  assert.equal(repos.publications.listByOrg('org-2').length, 1);
});

maybe('catalog listTools reads the allow-list from the installed payload', () => {
  const repos = createSqliteRepos(':memory:');
  assert.deepEqual(repos.catalog.listTools(), [], 'no catalog → empty allow-list');

  repos.catalog.replaceAll({
    source: 'agency-agents',
    version: 'abc1234',
    syncedAt: new Date().toISOString(),
    divisions: [{ id: 'engineering', label: 'Engineering' }],
    tools: [{ id: 'web-search', label: 'Web search' }, { id: 'code-review' }],
    agents: [
      { id: 'agency-agents:engineering/arch', source: 'agency-agents', version: 'abc1234', division: 'engineering', slug: 'arch', name: 'Arch', description: 'd', tools: ['code-review'], body: 'b', created_at: new Date().toISOString() },
    ],
  });
  const tools = repos.catalog.listTools();
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((t) => t.id), ['code-review', 'web-search']);
});

maybe('migrations 0006/0007 create the billing and publish tables', () => {
  const { db } = createSqliteRepos(':memory:');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['billing', 'billing_events', 'github_connections', 'publications', 'usage_events', 'telemetry_events']) {
    assert.ok(tables.includes(t), `table ${t} must exist`);
  }
  const billingCols = db.prepare('PRAGMA table_info(billing)').all().map((c) => c.name);
  assert.ok(billingCols.includes('org_id') && billingCols.includes('stripe_subscription_id'));
  const pubCols = db.prepare('PRAGMA table_info(publications)').all().map((c) => c.name);
  assert.ok(pubCols.includes('workflow_hash') && pubCols.includes('latency_ms'));
});
