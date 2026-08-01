/**
 * sqliteRepos.js — SQLite implementations of the repository ports.
 *
 * Uses `node:sqlite` (built into Node 22+) so there is no native-build
 * dependency to install. JSON-heavy fields (answers, spec, workflow nodes) are
 * stored as TEXT columns holding JSON — SQLite is the durable key/value store,
 * the domain owns the shape. See docs/adr/0003 for the trade-off.
 *
 * Multi-tenant isolation (Increment 2): every repository method takes an
 * `orgId` and every SQL statement scopes by it — `WHERE org_id = ?` on reads,
 * the owning org written into `org_id` on writes, and org checks on upserts.
 * A row that belongs to another tenant is indistinguishable from a row that
 * does not exist (queries return null/empty → the service answers 404). This
 * is the storage-layer half of the auth choke point.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { runMigrations } from './migrate.js';

/**
 * @param {string} [filename] Path to the db file, or ':memory:' for ephemeral.
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log] Progress sink for the migration runner.
 * @returns {{ db: import('node:sqlite').DatabaseSync, projects: any, workflows: any, grillSessions: any, vaultKeys: any }}
 */
export function createSqliteRepos(filename = ':memory:', { log } = {}) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  // Schema lives in server/migrations/*.sql; the runner applies pending files
  // once, in order. This is the single source of schema truth for both the
  // running server and the in-memory test databases.
  runMigrations(db, log ? { log } : undefined);

  const projectRepo = {
    create({ orgId, prompt, answers = {}, spec = null }) {
      const now = new Date().toISOString();
      const id = randomUUID();
      db.prepare(
        'INSERT INTO projects (id, org_id, prompt, answers, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, orgId, prompt, JSON.stringify(answers), spec ? JSON.stringify(spec) : null, now, now);
      return this.get(orgId, id);
    },
    get(orgId, id) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(id, orgId);
      return row ? rowToProject(row) : null;
    },
    list(orgId) {
      // (org_id, updated_at) composite index serves exactly this access path.
      const rows = db.prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY updated_at DESC').all(orgId);
      return rows.map(rowToProject);
    },
    update(orgId, id, patch) {
      const existing = this.get(orgId, id);
      if (!existing) return null;
      const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      // org_id is deliberately NOT part of the SET list — a tenant's identity
      // is immutable and set at insert time by the choke point.
      db.prepare(
        'UPDATE projects SET prompt = ?, answers = ?, spec = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      ).run(
        next.prompt,
        JSON.stringify(next.answers ?? {}),
        next.spec ? JSON.stringify(next.spec) : null,
        next.updatedAt,
        id,
        orgId,
      );
      return this.get(orgId, id);
    },
    remove(orgId, id) {
      const info = db.prepare('DELETE FROM projects WHERE id = ? AND org_id = ?').run(id, orgId);
      return info.changes > 0;
    },
  };

  const workflowRepo = {
    save(orgId, projectId, workflow) {
      // Upsert guard: if a workflow row already exists for this project it must
      // belong to the same org, or the write is a cross-tenant overwrite.
      const existing = db.prepare('SELECT org_id FROM workflows WHERE project_id = ?').get(projectId);
      if (existing && existing.org_id !== orgId) return null;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO workflows (project_id, org_id, workflow, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET org_id = excluded.org_id, workflow = excluded.workflow, updated_at = excluded.updated_at`,
      ).run(projectId, orgId, JSON.stringify(workflow), now);
      return this.getByProject(orgId, projectId);
    },
    getByProject(orgId, projectId) {
      const row = db.prepare('SELECT workflow FROM workflows WHERE project_id = ? AND org_id = ?').get(projectId, orgId);
      return row ? JSON.parse(row.workflow) : null;
    },
  };

  const grillSessionsRepo = {
    record(orgId, projectId, { round, answers = {}, coverage = 0, ready = false } = {}) {
      const now = new Date().toISOString();
      const id = randomUUID();
      db.prepare(
        `INSERT INTO grill_sessions (id, org_id, project_id, round, answers, coverage, ready, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, orgId, projectId, round, JSON.stringify(answers), coverage, ready ? 1 : 0, now, now);
      return this.getLatest(orgId, projectId);
    },
    listByProject(orgId, projectId) {
      const rows = db
        .prepare('SELECT * FROM grill_sessions WHERE org_id = ? AND project_id = ? ORDER BY round ASC')
        .all(orgId, projectId);
      return rows.map(rowToSession);
    },
    getLatest(orgId, projectId) {
      const row = db
        .prepare('SELECT * FROM grill_sessions WHERE org_id = ? AND project_id = ? ORDER BY round DESC LIMIT 1')
        .get(orgId, projectId);
      return row ? rowToSession(row) : null;
    },
  };

  const vaultKeysRepo = {
    insert({ id, orgId, provider, label, keyHandle, maskedKey, wrappedDek, wrappedKey }) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO vault_keys (id, org_id, provider, label, key_handle, masked_key, wrapped_dek, wrapped_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, orgId, provider, label, keyHandle, maskedKey, wrappedDek, wrappedKey, now, now);
      return this.getByOrg(orgId, id);
    },
    listByOrg(orgId) {
      const rows = db.prepare('SELECT * FROM vault_keys WHERE org_id = ? ORDER BY updated_at DESC').all(orgId);
      return rows.map(rowToVaultKey);
    },
    getByOrg(orgId, id) {
      const row = db.prepare('SELECT * FROM vault_keys WHERE org_id = ? AND id = ?').get(orgId, id);
      return row ? rowToVaultKey(row) : null;
    },
    getByKeyHandle(orgId, keyHandle) {
      const row = db.prepare('SELECT * FROM vault_keys WHERE org_id = ? AND key_handle = ?').get(orgId, keyHandle);
      return row ? rowToVaultKey(row) : null;
    },
    removeByOrg(orgId, id) {
      const info = db.prepare('DELETE FROM vault_keys WHERE org_id = ? AND id = ?').run(orgId, id);
      return info.changes > 0;
    },
  };

  return {
    db,
    projects: projectRepo,
    workflows: workflowRepo,
    grillSessions: grillSessionsRepo,
    vaultKeys: vaultKeysRepo,
    /**
     * Readiness probe for GET /api/health — one cheap round-trip. Never
     * throws: a broken database reports `{ ok: false, error }` so the health
     * endpoint can answer 503 instead of crashing the probe.
     */
    ping() {
      const t0 = performance.now();
      try {
        db.prepare('SELECT 1').get();
        return { ok: true, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}

function rowToProject(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    prompt: row.prompt,
    answers: JSON.parse(row.answers || '{}'),
    spec: row.spec ? JSON.parse(row.spec) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSession(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    round: row.round,
    answers: JSON.parse(row.answers || '{}'),
    coverage: row.coverage,
    ready: row.ready === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVaultKey(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    label: row.label,
    keyHandle: row.key_handle,
    maskedKey: row.masked_key,
    wrappedDek: row.wrapped_dek,
    wrappedKey: row.wrapped_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
