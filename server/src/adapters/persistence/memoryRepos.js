/**
 * memoryRepos.js — in-memory implementations of the repository ports.
 *
 * Used by the unit tests (zero I/O, deterministic) and handy for a quick demo
 * without a database. The SQLite adapter mirrors this exact surface — same
 * org-scoped signatures, same isolation semantics (a foreign-org lookup is
 * indistinguishable from a missing row).
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
    record(orgId, projectId, { round, answers = {}, coverage = 0, ready = false } = {}) {
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        orgId,
        projectId,
        round,
        answers: clone(answers),
        coverage,
        ready,
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

  return {
    projects: projectRepo,
    workflows: workflowRepo,
    grillSessions: grillSessionsRepo,
    vaultKeys: vaultKeysRepo,
    /** Readiness probe for GET /api/health — always ready, zero latency. */
    ping() {
      return { ok: true, latencyMs: 0 };
    },
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));
