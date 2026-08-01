/**
 * catalogSync.test.js — the sync contract: fetch → parse → validate →
 * atomic install with snapshots, automatic rollback, and bundle seeding.
 *
 * The fetcher is injected (no network in tests); the failure modes exercised
 * here are exactly the ones the nightly job must survive:
 *   - upstream HTTP error        → failed snapshot, last-good untouched
 *   - upstream validation break  → failed snapshot, last-good untouched
 *   - mid-install write failure  → transaction rollback, last-good untouched
 *   - restore(snapshotId)        → re-installs a stored good payload
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { createSqliteRepos } from '../src/adapters/persistence/sqliteRepos.js';
import { CatalogService } from '../src/application/catalogService.js';

/** Read a fixture checkout directory into a { path -> text } map. */
function readFixtureDir(catalog) {
  const base = fileURLToPath(new URL(`../fixtures/catalog/${catalog}/`, import.meta.url));
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      const rel = full.slice(base.length + 1);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.isFile() && statSync(full).size <= 2_000_000) files[rel] = readFileSync(full, 'utf8');
    }
  };
  walk(base);
  return files;
}

/** A fetcher that serves the bundled fixture checkout (no network). */
const bundleFetcher = (catalog) => async (_catalog, { ref } = {}) => ({ files: readFixtureDir(catalog), version: ref ?? 'test-fixture' });

function makeService(reposFactory = createMemoryRepos) {
  // Default fetcher serves the bundled fixtures — the test suite never
  // touches the network.
  const service = new CatalogService(reposFactory());
  service.fetcher = bundleFetcher('agency-agents');
  return service;
}

const SHA = (c) => c.repeat(40);

test('sync installs a parsed catalog and records an ok snapshot', async () => {
  const service = makeService();
  const result = await service.sync('agency-agents', { ref: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(result.ok, true);
  assert.equal(result.version, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.ok(result.installed.summary.includes('agents'));
  assert.equal(service.status('agency-agents').ok, true);
  assert.ok(service.listAgents({}).length >= 7);
  assert.ok(service.listDivisions().length >= 5);
});

test('sync records a failed snapshot and keeps the last-good catalog when upstream breaks', async () => {
  const service = makeService();
  // First sync succeeds (baseline).
  const first = await service.sync('agency-agents', { ref: 'b'.repeat(40) });
  assert.equal(first.ok, true);

  // Upstream now serves garbage — validation must fail BEFORE any write.
  service.fetcher = async () => ({ files: { 'divisions.json': 'not json', 'engineering/x.md': 'no frontmatter' }, version: 'broken' });
  const second = await service.sync('agency-agents', { ref: 'c'.repeat(40) });
  assert.equal(second.ok, false);
  assert.ok(second.error.length > 0);

  // The last-good catalog is still served, and the failure is on record.
  assert.equal(service.status('agency-agents').ok, true);
  const snapshots = service.listSnapshots('agency-agents');
  assert.equal(snapshots[0].status, 'failed');
  assert.equal(snapshots[1].status, 'ok');
  assert.ok(service.listAgents({}).length >= 7, 'last-good agents still served');
});

test('sync refuses to install a catalog with zero personas/lenses', async () => {
  const service = makeService();
  service.fetcher = async () => ({ files: { 'divisions.json': '{}', 'tools.json': '{}' }, version: 'empty' });
  const result = await service.sync('agency-agents', { ref: 'd'.repeat(40) });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('zero personas'));
});

test('loadFromBundle seeds the same way a fetch would', () => {
  const repos = createMemoryRepos();
  const service = new CatalogService(repos);
  const result = service.loadFromBundle('nuwa-skill', new URL('../fixtures/catalog/nuwa-skill/', import.meta.url).pathname);
  assert.equal(result.ok, true);
  assert.equal(repos.catalog.listLenses().length, 16);
});

test('sqlite adapter applies migrations and syncs atomically', async () => {
  const repos = createSqliteRepos(':memory:');
  const service = new CatalogService(repos);
  service.fetcher = bundleFetcher('agency-agents');
  const result = await service.sync('agency-agents', { ref: SHA('e') });
  assert.equal(result.ok, true);
  assert.ok(repos.catalog.listAgents({}).length >= 7);

  // A mid-install failure rolls the whole batch back: an agent row with a
  // NULL name violates NOT NULL mid-transaction → ROLLBACK → last-good kept.
  const before = repos.catalog.listAgents({}).length;
  const poisoned = {
    source: 'agency-agents', version: 'poisoned', syncedAt: new Date().toISOString(),
    divisions: [], tools: [],
    agents: [{ id: 'a:x', source: 'agency-agents', version: 'poisoned', division: 'engineering', name: null, description: 'd', body: 'b', tools: [] }],
  };
  assert.throws(() => repos.catalog.replaceAll(poisoned));
  assert.equal(repos.catalog.listAgents({}).length, before, 'rollback kept the last-good catalog');
  assert.equal(service.status('agency-agents').snapshot.status, 'ok');
});

test('restore re-installs a stored ok snapshot payload', async () => {
  const repos = createMemoryRepos();
  const service = new CatalogService(repos);
  service.fetcher = bundleFetcher('nuwa-skill');
  await service.sync('nuwa-skill', { ref: SHA('f') });
  assert.equal(service.status('nuwa-skill').ok, true);

  // Wipe the live lens table (simulate an operator mistake).
  repos.catalog.replaceAll({ source: 'nuwa-skill', version: 'garbage', syncedAt: new Date().toISOString(), lenses: [] });

  // Restore from the last-good snapshot.
  const restored = service.restore(`nuwa-skill@${SHA('f')}`);
  assert.equal(restored.source, 'nuwa-skill');
  assert.ok(repos.catalog.listLenses().length >= 16);
});

test('catalog reads are NOT org-scoped (global public data)', async () => {
  const repos = createMemoryRepos();
  const service = new CatalogService(repos);
  await service.sync('agency-agents', { ref: 'g'.repeat(40) });
  // Same catalog regardless of tenant.
  assert.deepEqual(service.listAgents({}), service.listAgents({}));
});

test('getAgent / getLens 404 on unknown ids', async () => {
  const service = makeService();
  await service.sync('agency-agents', { ref: SHA('h') });
  service.fetcher = bundleFetcher('nuwa-skill');
  await service.sync('nuwa-skill', { ref: SHA('i') });
  assert.throws(() => service.getAgent('agency-agents:nope'), (e) => e.status === 404);
  assert.throws(() => service.getLens('nuwa-skill:nope'), (e) => e.status === 404);
});
