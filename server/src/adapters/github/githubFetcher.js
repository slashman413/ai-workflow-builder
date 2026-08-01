/**
 * githubFetcher.js — the sandboxed upstream fetcher for catalog sync.
 *
 * Downloads a pinned GitHub ref as a tarball (codeload.github.com — ONE
 * request per catalog, no rate-limit surface), extracts it to a temp
 * directory, verifies the archive matches the pinned commit (the tarball
 * root directory is `<repo>-<shortSha>`, so a rewritten/moved upstream is
 * detected before a single byte is parsed), and returns the checkout as a
 * plain `{ path -> text }` map.
 *
 * "Sandboxed" means three things:
 *   1. Nothing is ever executed — only `.md`/`.json` text files are read.
 *   2. Extraction happens in an OS temp directory that is always removed.
 *   3. The parser + validator run BEFORE any database write (CatalogService).
 *
 * The file walk is catalog-specific: agency-agents needs divisions.json,
 * tools.json, and `<division>/<slug>.md` persona files; nuwa-skill needs
 * SKILL.md, references/*.md and examples/<name>/{SKILL,FIDELITY}.md.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import * as tar from 'tar';
import { EXCLUDED_DIRS } from '../../domain/catalog/agencyAgents.js';

/** Upstream defaults — production pins the immutable fork for agency-agents. */
export const CATALOG_SOURCES = Object.freeze({
  'agency-agents': {
    owner: 'slashman413', // immutable fork; canonical upstream: msitarzewski/agency-agents
    repo: 'agency-agents',
    defaultRef: 'main',
  },
  'nuwa-skill': {
    owner: 'alchaincyf',
    repo: 'nuwa-skill',
    defaultRef: 'main',
  },
});

const MAX_SINGLE_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 30_000_000;

/**
 * Fetch a pinned ref of a catalog repo and read its text files.
 *
 * @param {string} catalog  'agency-agents' | 'nuwa-skill'
 * @param {object} [opts]
 * @param {string} [opts.ref]        Full commit SHA (immutable pin) or a
 *   branch/tag name. When a SHA is given, the archive is verified against it.
 * @param {object} [opts.source]     Override CATALOG_SOURCES entry (tests).
 * @param {string} [opts.tmpBase]    Parent of the temp dir (tests).
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ version: string, files: Record<string,string>,
 *                      extractedDir: string, ref: string }>}
 */
export async function fetchCatalogTarball(catalog, { ref, source, tmpBase, log = () => {} } = {}) {
  const cfg = source ?? CATALOG_SOURCES[catalog];
  if (!cfg) throw new Error(`Unknown catalog "${catalog}"`);
  const { owner, repo } = cfg;
  const refName = ref ?? cfg.defaultRef;

  const dir = await mkdtemp(join(tmpBase ?? tmpdir(), `catalog-${catalog}-`));
  try {
    const tgzPath = join(dir, 'checkout.tgz');
    log(`[sync] fetching ${owner}/${repo}@${refName} …`);
    const res = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(refName)}`, {
      redirect: 'follow',
      headers: { 'user-agent': 'ai-workflow-builder-catalog-sync' },
    });
    if (!res.ok) {
      throw new Error(`GitHub codeload returned HTTP ${res.status} for ${owner}/${repo}@${refName}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error('Downloaded tarball is empty.');
    if (buf.byteLength > MAX_TOTAL_BYTES) throw new Error(`Tarball too large (${buf.byteLength} bytes).`);
    await writeFile(tgzPath, buf);

    const extractDir = join(dir, 'tree');
    await tar.x({ file: tgzPath, cwd: extractDir, strict: true });

    const entries = await readdir(extractDir, { withFileTypes: true });
    const root = entries.find((e) => e.isDirectory())?.name;
    if (!root) throw new Error('Tarball has no root directory.');

    // Immutable-pin verification: a codeload tarball of a full SHA names its
    // root `<repo>-<first 7 of sha>`. A mismatch means the ref moved or the
    // archive is not what we pinned.
    if (/^[0-9a-f]{40}$/i.test(refName)) {
      const expectedPrefix = `${repo}-${refName.slice(0, 7)}`;
      if (root !== expectedPrefix) {
        throw new Error(
          `Pinned-ref verification failed: archive root "${root}" does not match expected "${expectedPrefix}" ` +
            `— the pinned commit ${refName} no longer resolves as fetched.`,
        );
      }
    }

    const base = join(extractDir, root);
    const files = await walkTextFiles(base, catalog, log);
    return { version: refName, ref: refName, files, extractedDir: base };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Recursively read the text files a catalog cares about.
 * Everything else (binaries, images, scripts) is skipped — never read,
 * never executed.
 */
async function walkTextFiles(base, catalog, log) {
  const files = {};
  let total = 0;
  const wanted = (rel) => {
    if (catalog === 'nuwa-skill') {
      return (
        rel === 'SKILL.md' ||
        rel.startsWith('references/') ||
        rel.startsWith('examples/') && (rel.endsWith('/SKILL.md') || rel.endsWith('/FIDELITY.md'))
      );
    }
    // agency-agents: divisions.json, tools.json, <division>/<slug>.md
    if (rel === 'divisions.json' || rel === 'tools.json') return true;
    const parts = rel.split('/');
    if (parts.length === 2 && parts[1].endsWith('.md')) return !EXCLUDED_DIRS.has(parts[0]);
    return false;
  };

  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = full.slice(base.length + 1).split(sep).join('/');
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !wanted(rel)) continue;
      const stat = await readFile(full).then((b) => ({ size: b.byteLength, data: b })).catch(() => null);
      if (!stat) continue;
      if (stat.size > MAX_SINGLE_FILE_BYTES) {
        log(`[sync] skipping oversized file ${rel} (${stat.size} bytes)`);
        continue;
      }
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) throw new Error('Extracted text exceeds the catalog size cap.');
      files[rel] = stat.data.toString('utf8');
    }
  };
  await walk(base);

  const counts = Object.keys(files).length;
  log(`[sync] read ${counts} text file${counts === 1 ? '' : 's'} (${total} bytes)`);
  return files;
}
