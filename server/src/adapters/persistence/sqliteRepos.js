/**
 * sqliteRepos.js — SQLite implementations of the repository ports.
 *
 * Uses `node:sqlite` (built into Node 22+) so there is no native-build
 * dependency to install. JSON-heavy fields (answers, spec, workflow nodes) are
 * stored as TEXT columns holding JSON — SQLite is the durable key/value store,
 * the domain owns the shape. See docs/adr/0003 for the trade-off.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { runMigrations } from './migrate.js';

/**
 * @param {string} [filename] Path to the db file, or ':memory:' for ephemeral.
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log] Progress sink for the migration runner.
 * @returns {{ db: import('node:sqlite').DatabaseSync, projects: any, workflows: any }}
 */
export function createSqliteRepos(filename = ':memory:', { log } = {}) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  // Schema lives in server/migrations/*.sql; the runner applies pending files
  // once, in order. This is the single source of schema truth for both the
  // running server and the in-memory test databases.
  runMigrations(db, log ? { log } : undefined);

  const projectRepo = {
    create({ prompt, answers = {}, spec = null }) {
      const now = new Date().toISOString();
      const id = randomUUID();
      db.prepare(
        'INSERT INTO projects (id, prompt, answers, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, prompt, JSON.stringify(answers), spec ? JSON.stringify(spec) : null, now, now);
      return this.get(id);
    },
    get(id) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      return row ? rowToProject(row) : null;
    },
    list() {
      const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
      return rows.map(rowToProject);
    },
    update(id, patch) {
      const existing = this.get(id);
      if (!existing) return null;
      const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      db.prepare('UPDATE projects SET prompt = ?, answers = ?, spec = ?, updated_at = ? WHERE id = ?').run(
        next.prompt,
        JSON.stringify(next.answers ?? {}),
        next.spec ? JSON.stringify(next.spec) : null,
        next.updatedAt,
        id,
      );
      return this.get(id);
    },
    remove(id) {
      const info = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return info.changes > 0;
    },
  };

  const workflowRepo = {
    save(projectId, workflow) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO workflows (project_id, workflow, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET workflow = excluded.workflow, updated_at = excluded.updated_at`,
      ).run(projectId, JSON.stringify(workflow), now);
      return this.getByProject(projectId);
    },
    getByProject(projectId) {
      const row = db.prepare('SELECT workflow FROM workflows WHERE project_id = ?').get(projectId);
      return row ? JSON.parse(row.workflow) : null;
    },
  };

  return { db, projects: projectRepo, workflows: workflowRepo };
}

function rowToProject(row) {
  return {
    id: row.id,
    prompt: row.prompt,
    answers: JSON.parse(row.answers || '{}'),
    spec: row.spec ? JSON.parse(row.spec) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
