/**
 * memoryRepos.js — in-memory implementations of the repository ports.
 *
 * Used by the unit tests (zero I/O, deterministic) and handy for a quick demo
 * without a database. The SQLite adapter mirrors this exact surface — same
 * org-scoped signatures, same isolation semantics (a foreign-org lookup is
 * indistinguishable from a missing row).
 *
 * Increment 3: `catalog` (global public MIT data, not org-scoped) and
 * `grillSessions.usage()` (guardrail counters) mirror the SQLite adapter.
 */

import { randomUUID } from 'node:crypto';

export function createMemoryRepos() {
  /** @type {Map<string, any>} id -> project */
  const projects = new Map();
  /** @type {Map<string, any>} projectId -> workflow */
  const workflows = new Map();
  /** @type {Map<string, any>} id -> grill session row */
  const grillSessions = new Map();
  /** @type {Map<string, any>} id -> vault key record */
  const vaultKeys = new Map();

  const projectRepo = {
    create({ orgId, prompt, answers = {}, spec = null }) {
      const now = new Date().toISOString();
      const project = { id: randomUUID(), orgId, prompt, answers, spec, createdAt: now, updatedAt: now };
      projects.set(project.id, project);
      return clone(project);
    },
    get(orgId, id) {
      const p = projects.get(id);
      return p && p.orgId === orgId ? clone(p) : null;
    },
    list(orgId) {
      return [...projects.values()]
        .filter((p) => p.orgId === orgId)
        .map(clone)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    update(orgId, id, patch) {
      const p = projects.get(id);
      if (!p || p.orgId !== orgId) return null;
      Object.assign(p, patch, { updatedAt: new Date().toISOString() });
      return clone(p);
    },
    remove(orgId, id) {
      const p = projects.get(id);
      if (!p || p.orgId !== orgId) return false;
      workflows.delete(id);
      for (const [sid, s] of grillSessions) if (s.projectId === id) grillSessions.delete(sid);
      return projects.delete(id);
    },
  };

  const workflowRepo = {
    save(orgId, projectId, workflow) {
      const existing = workflows.get(projectId);
      if (existing && existing.orgId !== orgId) return null;
      const record = { orgId, workflow: clone(workflow) };
      workflows.set(projectId, record);
      return clone(workflow);
    },
    getByProject(orgId, projectId) {
      const w = workflows.get(projectId);
      return w && w.orgId === orgId ? clone(w.workflow) : null;
    },
  };

  const grillSessionsRepo = {
    record(orgId, projectId, { round, answers = {}, coverage = 0, ready = false, turns = 0, tokensUsed = 0 } = {}) {
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        orgId,
        projectId,
        round,
        answers: clone(answers),
        coverage,
        ready,
        turns,
        tokensUsed,
        createdAt: now,
        updatedAt: now,
      };
      grillSessions.set(session.id, session);
      return clone(session);
    },
    listByProject(orgId, projectId) {
      return [...grillSessions.values()]
        .filter((s) => s.orgId === orgId && s.projectId === projectId)
        .sort((a, b) => a.round - b.round)
        .map(clone);
    },
    getLatest(orgId, projectId) {
      const list = this.listByProject(orgId, projectId);
      return list.length ? list[list.length - 1] : null;
    },
    /** Cumulative guardrail counters for the project's grill session. */
    usage(orgId, projectId) {
      const latest = this.getLatest(orgId, projectId);
      return latest ? { turns: latest.turns ?? 0, tokensUsed: latest.tokensUsed ?? 0 } : null;
    },
  };

  const vaultKeysRepo = {
    insert(record) {
      const now = new Date().toISOString();
      const full = { ...record, createdAt: now, updatedAt: now };
      vaultKeys.set(full.id, full);
      return clone(full);
    },
    listByOrg(orgId) {
      return [...vaultKeys.values()]
        .filter((r) => r.orgId === orgId)
        .map(clone)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    getByOrg(orgId, id) {
      const r = vaultKeys.get(id);
      return r && r.orgId === orgId ? clone(r) : null;
    },
    getByKeyHandle(orgId, keyHandle) {
      for (const r of vaultKeys.values()) {
        if (r.orgId === orgId && r.keyHandle === keyHandle) return clone(r);
      }
      return null;
    },
    removeByOrg(orgId, id) {
      const r = vaultKeys.get(id);
      if (!r || r.orgId !== orgId) return false;
      return vaultKeys.delete(id);
    },
  };

  // ---------------------------------------------------------------------------
  // Catalog (Increment 3) — mirrors the SQLite adapter's surface exactly so the
  // service layer is adapter-agnostic. Global public data, not org-scoped.
  //
  // Contract (see application/ports.js):
  //   replaceAll(payload)   atomic swap of one source's catalog; THROWS (before
  //                         any mutation) on rows that would violate the
  //                         storage constraints — the last-good snapshot stays.
  //   recordFailure(...)    failed sync row; live catalog untouched.
  //   restore(snapshotId)   re-install a stored 'ok' payload.
  //   getSnapshot / listSnapshots / listDivisions / listAgents / getAgent /
  //   listLenses / getLens / hasCatalog
  // ---------------------------------------------------------------------------
  /** @type {Map<string, object>} source -> live catalog payload */
  const catalogs = new Map();
  /** @type {Map<string, object>} snapshot id -> snapshot row (payload archived) */
  const snapshots = new Map();
  /** Monotonic insertion order so equal-timestamp rows stay deterministic. */
  let seq = 0;

  const catalogRepo = {
    replaceAll(payload) {
      const { source, version } = payload;
      // Storage-constraint guard: the SQLite adapter enforces NOT NULL on
      // these fields mid-transaction (and rolls back); the memory adapter
      // enforces the same rule BEFORE mutating anything so both fail
      // identically and the last-good catalog stays installed.
      for (const a of payload.agents ?? []) {
        if (a == null || a.name == null || a.description == null || a.body == null || a.division == null) {
          throw new Error(`Persona row violates storage constraints (missing required field): ${a?.id ?? 'unknown'}`);
        }
      }
      for (const l of payload.lenses ?? []) {
        if (l == null || l.name == null || l.description == null || l.body == null) {
          throw new Error(`Lens row violates storage constraints (missing required field): ${l?.id ?? 'unknown'}`);
        }
      }

      catalogs.set(source, clone(payload));
      const now = new Date().toISOString();
      const snapshot = {
        id: `${source}@${version}`,
        source,
        version,
        status: 'ok',
        summary: payload.agents
          ? `${payload.agents.length} agents, ${payload.divisions.length} divisions, ${payload.tools.length} tools`
          : `${payload.lenses.length} lenses`,
        error: null,
        syncedAt: payload.syncedAt ?? now,
        createdAt: now,
        _seq: ++seq,
        payload: clone(payload), // the archived install — restore() re-installs this
      };
      snapshots.set(snapshot.id, snapshot);
      return this.getSnapshot(source);
    },
    recordFailure(source, version, error) {
      const now = new Date().toISOString();
      const snapshot = {
        id: `${source}@${version}`,
        source,
        version,
        status: 'failed',
        summary: 'sync failed',
        error: String(error).slice(0, 2000),
        syncedAt: now,
        createdAt: now,
        _seq: ++seq,
        payload: null,
      };
      snapshots.set(snapshot.id, snapshot);
      return this.getSnapshot(source);
    },
    restore(snapshotId) {
      const row = snapshots.get(snapshotId);
      if (!row || row.status !== 'ok' || !row.payload) return null;
      this.replaceAll(row.payload);
      return this.getSnapshot(row.source);
    },
    getSnapshot(source) {
      const rows = this.listSnapshots(source);
      return rows.length ? rows[0] : null;
    },
    listSnapshots(source) {
      return [...snapshots.values()]
        .filter((s) => s.source === source)
        .sort((a, b) => (b._seq - a._seq) || b.createdAt.localeCompare(a.createdAt))
        .map(({ _seq, payload, ...row }) => row)
        .slice(0, 20);
    },
    listDivisions() {
      const payload = catalogs.get('agency-agents');
      if (!payload?.agents) return [];
      // Prefer the divisions.json metadata (labels, icons, colors); fall back
      // to the division labels carried on the persona rows.
      if (Array.isArray(payload.divisions) && payload.divisions.length > 0) {
        return payload.divisions
          .map((d) => ({ id: d.id, label: d.label ?? d.id, icon: d.icon ?? null, color: d.color ?? null }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      const seen = new Map();
      for (const a of payload.agents) {
        if (!seen.has(a.division)) seen.set(a.division, a.divisionLabel ?? a.division);
      }
      return [...seen.entries()]
        .map(([id, label]) => ({ id, label }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    listAgents({ division = null, q = null, limit = 100 } = {}) {
      const payload = catalogs.get('agency-agents');
      if (!payload?.agents) return [];
      const query = String(q ?? '').toLowerCase().trim();
      const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      return payload.agents
        .filter((a) => !division || a.division === division)
        .filter((a) => !query || [a.name, a.description, a.vibe ?? ''].some((f) => String(f).toLowerCase().includes(query)))
        .map(clone)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, safeLimit);
    },
    getAgent(id) {
      const payload = catalogs.get('agency-agents');
      const agent = payload?.agents?.find((a) => a.id === id);
      return agent ? clone(agent) : null;
    },
    listLenses() {
      const payload = catalogs.get('nuwa-skill');
      return payload?.lenses ? payload.lenses.map(clone).sort((a, b) => a.name.localeCompare(b.name)) : [];
    },
    getLens(id) {
      const payload = catalogs.get('nuwa-skill');
      const lens = payload?.lenses?.find((l) => l.id === id);
      return lens ? clone(lens) : null;
    },
    hasCatalog(source) {
      return catalogs.has(source) && (catalogs.get(source)?.agents?.length > 0 || catalogs.get(source)?.lenses?.length > 0);
    },
  };

  return {
    projects: projectRepo,
    workflows: workflowRepo,
    grillSessions: grillSessionsRepo,
    vaultKeys: vaultKeysRepo,
    catalog: catalogRepo,
    /** Readiness probe for GET /api/health — always ready, zero latency. */
    ping() {
      return { ok: true, latencyMs: 0 };
    },
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));
