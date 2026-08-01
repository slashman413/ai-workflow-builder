#!/usr/bin/env node
/**
 * sync-catalogs.js — the nightly ecosystem catalog sync (operator CLI).
 *
 * Usage:
 *   node src/cli/sync-catalogs.js --catalog all                # both upstreams
 *   node src/cli/sync-catalogs.js --catalog agency-agents      # one upstream
 *   node src/cli/sync-catalogs.js --catalog all --ref <sha>    # pin a commit
 *   node src/cli/sync-catalogs.js --catalog all --from-bundle  # bundled seed
 *   node src/cli/sync-catalogs.js --restore <snapshotId>       # manual rollback
 *
 * Options:
 *   --catalog  all | agency-agents | nuwa-skill   (default: all)
 *   --ref      full commit SHA to pin (immutable version pinning)
 *   --db       SQLite file (default: ./data/app.db)
 *   --from-bundle  install the bundled fixtures instead of fetching GitHub
 *   --restore  <snapshotId>  re-install a stored 'ok' snapshot payload
 *   --dry-run  fetch + parse + validate but do NOT write to the database
 *
 * Exit code: 0 when every requested catalog is installed (or dry-run
 * validated), 1 when any sync failed. Meant for cron:
 *   0 3 * * *  cd /srv/ai-workflow-builder && node server/src/cli/sync-catalogs.js --catalog all
 *
 * Safety: nothing here executes upstream content. The pipeline is
 * fetch → parse → validate → transactional install, and every failure is
 * recorded as a snapshot row while the last-good catalog stays live.
 */

import { createSqliteRepos } from '../adapters/persistence/sqliteRepos.js';
import { CatalogService, CATALOGS } from '../application/catalogService.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', '..', 'fixtures', 'catalog');

function parseArgs(argv) {
  const args = { catalog: 'all', ref: null, db: process.env.DB_FILE ?? './data/app.db', fromBundle: false, restore: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--catalog') args.catalog = argv[++i] ?? 'all';
    else if (a === '--ref') args.ref = argv[++i] ?? null;
    else if (a === '--db') args.db = argv[++i] ?? args.db;
    else if (a === '--from-bundle') args.fromBundle = true;
    else if (a === '--restore') args.restore = argv[++i] ?? null;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('sync-catalogs.js — nightly ecosystem catalog sync\n\nSee the header comment for usage.');
      process.exit(0);
    }
  }
  return args;
}

const log = (m) => console.log(m);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wanted = args.catalog === 'all' ? Object.keys(CATALOGS) : [args.catalog];
  for (const c of wanted) {
    if (!CATALOGS[c]) {
      console.error(`Unknown catalog "${c}". Valid: all, ${Object.keys(CATALOGS).join(', ')}`);
      process.exit(1);
    }
  }

  const repos = createSqliteRepos(args.db, { log });
  const service = new CatalogService(repos);
  let failed = 0;

  if (args.restore) {
    const restored = service.restore(args.restore);
    log(`[restore] ${restored.source} restored to ${restored.version} (${restored.summary})`);
    process.exit(0);
  }

  for (const catalog of wanted) {
    if (args.dryRun) {
      // Validate without writing: reuse the sync pipeline but with a
      // throwaway in-memory repo so nothing touches the real database.
      const mem = (await import('../adapters/persistence/memoryRepos.js')).createMemoryRepos();
      const dry = new CatalogService(mem);
      const result = args.fromBundle
        ? dry.loadFromBundle(catalog, join(FIXTURES_DIR, catalog))
        : await dry.sync(catalog, { ref: args.ref });
      if (!result.ok) {
        console.error(`[dry-run] ${catalog}: FAILED — ${result.error}`);
        failed += 1;
      } else {
        console.log(`[dry-run] ${catalog}: OK at ${result.version} (${result.installed?.summary ?? 'validated'})`);
      }
      continue;
    }

    const result = args.fromBundle
      ? service.loadFromBundle(catalog, join(FIXTURES_DIR, catalog))
      : await service.sync(catalog, { ref: args.ref });

    if (result.ok) {
      log(`[sync] ${catalog} installed at ${result.version} — ${result.installed?.summary}`);
    } else {
      console.error(`[sync] ${catalog} FAILED at ${result.version} — ${result.error}`);
      console.error(`[sync] last-good catalog remains installed (snapshots: ${service.status(catalog).snapshot?.version ?? 'none'})`);
      failed += 1;
    }
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
