/**
 * catalogService.js — use cases for the ecosystem catalogs (Increment 3).
 *
 * Two MIT upstreams are mirrored into a durable, versioned catalog:
 *
 *   - agency-agents  → Agent Marketplace (divisions = UI grouping, tools =
 *     permission tags, personas = agent node presets)
 *   - nuwa-skill     → Cognitive Lenses (distilled perspective skills as
 *     candidate system prompts for agent nodes)
 *
 * The sync contract (the part that keeps the site alive when upstream
 * breaks):
 *
 *   1. FETCH  — download the pinned ref tarball (sandboxed, verified).
 *   2. PARSE  — pure parsers turn the checkout into catalog records.
 *   3. VALIDATE — structural rules (counts, sizes, required fields). If
 *      upstream is broken, this FAILS HERE, before any database write.
 *   4. INSTALL — `replaceAll` swaps the live tables inside ONE transaction.
 *      A mid-write failure rolls the whole batch back, so the last-good
 *      catalog stays installed (automatic rollback). Every success writes a
 *      snapshot row whose payload IS the installed catalog — `restore()`
 *      can re-install it on demand.
 *
 * Reads are authenticated (route gate) but deliberately NOT org-scoped: the
 * catalog is public MIT data and every workspace sees the same marketplace.
 */

import { AppError } from './errors.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { parseAgencyAgents } from '../domain/catalog/agencyAgents.js';
import { parseNuwaSkill } from '../domain/catalog/nuwaSkill.js';
import { validateAgencyAgents, validateNuwaSkill, fitsPayloadLimit } from '../domain/catalog/validate.js';
import { fetchCatalogTarball, CATALOG_SOURCES } from '../adapters/github/githubFetcher.js';

export const CATALOGS = Object.freeze({
  'agency-agents': { parse: parseAgencyAgents, validate: validateAgencyAgents },
  'nuwa-skill': { parse: parseNuwaSkill, validate: validateNuwaSkill },
});

export class CatalogService {
  /**
   * @param {{ catalog: any }} repos
   * @param {object} [opts]
   * @param {(catalog: string, opts: object) => Promise<{files: Record<string,string>, version: string}>} [opts.fetcher]
   *   Injectable upstream fetcher (defaults to the GitHub tarball adapter).
   */
  constructor(repos, { fetcher = fetchCatalogTarball } = {}) {
    this.catalogRepo = repos.catalog;
    this.fetcher = fetcher;
  }

  /**
   * @returns {{ ok: boolean, snapshot: object|null, error?: string }}
   *   `ok` means a good snapshot is INSTALLED and being served — true even
   *   when the most recent sync attempt failed (the last-good catalog is
   *   still live). `snapshot` is the latest version row (any status).
   */
  status(source) {
    const snapshot = this.catalogRepo.getSnapshot(source);
    return { ok: this.catalogRepo.hasCatalog(source), snapshot };
  }

  /**
   * Sources with their pinned version rows — drives GET /catalog and the
   * marketplace header badges. Global MIT data: same for every org.
   */
  listSources() {
    return Object.keys(CATALOG_SOURCES).map((source) => {
      const snapshot = this.catalogRepo.getSnapshot(source);
      return {
        source,
        version: snapshot?.version ?? null,
        status: snapshot?.status ?? 'never-synced',
        ok: this.catalogRepo.hasCatalog(source),
        summary: snapshot?.summary ?? null,
        error: snapshot?.error ?? null,
        syncedAt: snapshot?.syncedAt ?? null,
      };
    });
  }

  /**
   * The full persona catalog grouped by division — the Agent Marketplace
   * payload. Each division carries its personas with tool permission tags.
   */
  getPersonas() {
    if (!this.catalogRepo.hasCatalog('agency-agents')) {
      throw new AppError('CATALOG_EMPTY', 'The agent marketplace has not been synced yet.', 404);
    }
    const snapshot = this.catalogRepo.getSnapshot('agency-agents');
    const agents = this.catalogRepo.listAgents({ limit: 500 });
    const divisions = this.catalogRepo.listDivisions();
    const byDivision = new Map(divisions.map((d) => [d.id, { ...d, agents: [] }]));
    for (const agent of agents) {
      if (!byDivision.has(agent.division)) {
        byDivision.set(agent.division, { id: agent.division, label: agent.divisionLabel ?? agent.division, agents: [] });
      }
      byDivision.get(agent.division).agents.push(agent);
    }
    // Only divisions that actually contain personas become marketplace groups —
    // divisions.json may declare more buckets than the snapshot has personas.
    const populated = [...byDivision.values()].filter((d) => d.agents.length > 0);
    return {
      source: 'agency-agents',
      version: snapshot?.version ?? null,
      syncedAt: snapshot?.syncedAt ?? null,
      divisions: populated,
    };
  }

  /** The lens catalog payload (version + lenses) — Cognitive Lens selector. */
  getLensesPayload() {
    if (!this.catalogRepo.hasCatalog('nuwa-skill')) {
      throw new AppError('CATALOG_EMPTY', 'The cognitive lens catalog has not been synced yet.', 404);
    }
    const snapshot = this.catalogRepo.getSnapshot('nuwa-skill');
    return {
      source: 'nuwa-skill',
      version: snapshot?.version ?? null,
      syncedAt: snapshot?.syncedAt ?? null,
      lenses: this.catalogRepo.listLenses(),
    };
  }

  /** Bare lens list (collection endpoint shape). */
  getLenses() {
    return this.catalogRepo.listLenses();
  }

  /**
   * Source-alias endpoint: /catalog/agency-agents → the persona marketplace,
   * /catalog/nuwa-skill → the lens catalog. Unknown sources are 404.
   */
  getCatalog(source) {
    if (source === 'agency-agents') return this.getPersonas();
    if (source === 'nuwa-skill') return this.getLensesPayload();
    throw new AppError('INVALID_CATALOG', `Unknown catalog "${source}". Known sources: agency-agents, nuwa-skill.`, 404);
  }

  /**
   * Update check for the skills/marketplace: reports the CURRENTLY PINNED
   * version of each source so the UI can render catalog version badges and
   * surface staleness. The nightly sync CLI (server/src/cli/sync-catalogs.js)
   * is what advances the pin; this endpoint never touches the network.
   */
  checkUpdates() {
    return Object.keys(CATALOG_SOURCES).map((source) => {
      const snapshot = this.catalogRepo.getSnapshot(source);
      return {
        source,
        version: snapshot?.version ?? null,
        status: snapshot?.status ?? 'never-synced',
        ok: this.catalogRepo.hasCatalog(source),
        summary: snapshot?.summary ?? null,
        syncedAt: snapshot?.syncedAt ?? null,
      };
    });
  }

  listDivisions() {
    return this.catalogRepo.listDivisions();
  }

  listAgents({ division, q, limit } = {}) {
    if (q !== undefined && q !== null && typeof q !== 'string') {
      throw new AppError('INVALID_QUERY', 'q must be a string.');
    }
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit))) {
      throw new AppError('INVALID_QUERY', 'limit must be a number.');
    }
    return this.catalogRepo.listAgents({
      division: typeof division === 'string' && division ? division : null,
      q: typeof q === 'string' && q.trim() ? q.trim() : null,
      limit,
    });
  }

  getAgent(id) {
    const agent = this.catalogRepo.getAgent(String(id));
    if (!agent) throw new AppError('NOT_FOUND', `Agent ${id} not found in the catalog.`, 404);
    return agent;
  }

  listLenses() {
    return this.catalogRepo.listLenses();
  }

  getLens(id) {
    const lens = this.catalogRepo.getLens(String(id));
    if (!lens) throw new AppError('NOT_FOUND', `Lens ${id} not found in the catalog.`, 404);
    return lens;
  }

  /**
   * Run one catalog sync against the upstream (the nightly job).
   * Never throws for upstream problems — it records the failure as a
   * snapshot row and returns a result object; the last-good catalog stays
   * installed.
   *
   * @param {string} catalog  'agency-agents' | 'nuwa-skill'
   * @param {object} [opts]
   * @param {string} [opts.ref] Pinned ref (defaults to the upstream default).
   * @returns {Promise<{ ok: boolean, source: string, version: string,
   *                      installed?: object, error?: string }>}
   */
  async sync(catalog, { ref } = {}) {
    const def = CATALOGS[catalog];
    if (!def) throw new AppError('INVALID_CATALOG', `Unknown catalog "${catalog}".`);
    const version = ref ?? CATALOG_SOURCES[catalog]?.defaultRef ?? 'main';

    try {
      // 1 + 2: fetch (sandboxed) and parse (pure).
      const { files, version: resolvedVersion } = await this.fetcher(catalog, { ref: version });
      const parsed = def.parse(files, { version: resolvedVersion });

      // 3: validate BEFORE any write. Broken upstream dies here.
      const check = def.validate(parsed);
      if (!check.ok) {
        const detail = check.errors.slice(0, 5).join('; ');
        throw new Error(`Upstream validation failed (${check.errors.length} issue(s)): ${detail}`);
      }
      if (!fitsPayloadLimit(parsed)) {
        throw new Error('Parsed catalog exceeds the payload size cap.');
      }
      if (parsed.agents && parsed.agents.length === 0) {
        throw new Error('Parsed agency-agents catalog contains zero personas — refusing to install.');
      }
      if (parsed.lenses && parsed.lenses.length === 0) {
        throw new Error('Parsed nuwa-skill catalog contains zero lenses — refusing to install.');
      }

      // 4: install atomically + snapshot.
      const snapshot = this.catalogRepo.replaceAll(parsed);
      return { ok: true, source: catalog, version: resolvedVersion, installed: snapshot };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.catalogRepo.recordFailure(catalog, version, message);
      return { ok: false, source: catalog, version, error: message };
    }
  }

  /**
   * Install the bundled fixture catalog (first boot / offline demo / CI).
   * Reads `server/fixtures/catalog/<catalog>/` exactly like a fetched
   * checkout — same parse → validate → install pipeline, so a broken
   * bundle fails the same way a broken upstream would.
   *
   * @param {string} catalog
   * @param {string} bundleDir  Absolute path to the fixture checkout.
   * @returns {{ ok: boolean, source: string, version: string, installed?: object, error?: string }}
   */
  loadFromBundle(catalog, bundleDir) {
    const def = CATALOGS[catalog];
    if (!def) throw new AppError('INVALID_CATALOG', `Unknown catalog "${catalog}".`);
    const version = `bundle-${catalog}`;
    try {
      const files = {};
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = `${dir}/${entry.name}`;
          const rel = full.slice(bundleDir.length + 1);
          if (entry.isDirectory()) { walk(full); continue; }
          if (entry.isFile() && statSync(full).size <= 2_000_000) files[rel] = readFileSync(full, 'utf8');
        }
      };
      walk(bundleDir);

      const parsed = def.parse(files, { version });
      const check = def.validate(parsed);
      if (!check.ok) {
        throw new Error(`Bundle validation failed: ${check.errors.slice(0, 5).join('; ')}`);
      }
      const snapshot = this.catalogRepo.replaceAll(parsed);
      return { ok: true, source: catalog, version, installed: snapshot };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.catalogRepo.recordFailure(catalog, version, message);
      return { ok: false, source: catalog, version, error: message };
    }
  }

  /** Manual rollback: re-install a stored 'ok' snapshot payload. */
  restore(snapshotId) {
    const snapshot = this.catalogRepo.restore(String(snapshotId));
    if (!snapshot) throw new AppError('NOT_FOUND', `No installable snapshot "${snapshotId}".`, 404);
    return snapshot;
  }

  listSnapshots(source) {
    return this.catalogRepo.listSnapshots(source);
  }
}
