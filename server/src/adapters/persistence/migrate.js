/**
 * migrate.js — a lightweight, dependency-free SQL migration runner for the
 * `node:sqlite` adapter.
 *
 * It applies every `*.sql` file in `server/migrations/` exactly once, in
 * filename (lexicographic) order, recording each in a `schema_migrations`
 * table. Each file runs inside its own transaction, so a failing migration
 * leaves the database on the last good version rather than half-applied.
 *
 * Boot-time contract: `createSqliteRepos()` calls this before returning repos,
 * so both the running server and the in-memory test databases share one source
 * of schema truth. Adding a schema change is just: drop a higher-numbered
 * `NNNN_description.sql` file into the migrations directory.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// server/src/adapters/persistence -> server/migrations
export const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'migrations');

/**
 * Apply all pending migrations to an open database.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [opts]
 * @param {string} [opts.dir] Override the migrations directory (tests).
 * @param {(msg: string) => void} [opts.log] Sink for progress lines.
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function runMigrations(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const done = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = [];
  const skipped = [];

  for (const name of files) {
    if (done.has(name)) {
      skipped.push(name);
      continue;
    }
    const sql = readFileSync(join(dir, name), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      applied.push(name);
      log(`[migrate] applied ${name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${err.message}`, { cause: err });
    }
  }

  if (applied.length === 0) log(`[migrate] schema up to date (${skipped.length} migrations)`);
  return { applied, skipped };
}
