/**
 * index.js — the composition root. This is the ONLY place that decides which
 * concrete adapters to wire together. Chooses SQLite in production, falls back
 * to in-memory if `DB_FILE` is unset and `USE_MEMORY=1`.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './adapters/http/app.js';
import { createSqliteRepos } from './adapters/persistence/sqliteRepos.js';
import { createMemoryRepos } from './adapters/persistence/memoryRepos.js';

const PORT = Number(process.env.PORT ?? 4000);
const DB_FILE = process.env.DB_FILE ?? './data/app.db';

function makeRepos() {
  if (process.env.USE_MEMORY === '1') {
    console.log('[db] using in-memory repositories (non-persistent)');
    return createMemoryRepos();
  }
  console.log(`[db] using SQLite at ${DB_FILE}`);
  mkdirSync(dirname(DB_FILE), { recursive: true });
  // Apply pending schema migrations at boot before serving traffic.
  const { projects, workflows } = createSqliteRepos(DB_FILE, { log: (m) => console.log(m) });
  return { projects, workflows };
}

const app = createApp(makeRepos());
app.listen(PORT, () => {
  console.log(`ai-workflow-builder API listening on http://localhost:${PORT}`);
});
