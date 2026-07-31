/**
 * memoryRepos.js — in-memory implementations of the repository ports.
 *
 * Used by the unit tests (zero I/O, deterministic) and handy for a quick demo
 * without a database. The SQLite adapter mirrors this exact surface.
 */

import { randomUUID } from 'node:crypto';

export function createMemoryRepos() {
  /** @type {Map<string, any>} */
  const projects = new Map();
  /** @type {Map<string, any>} projectId -> workflow */
  const workflows = new Map();

  const projectRepo = {
    create({ prompt, answers = {}, spec = null }) {
      const now = new Date().toISOString();
      const project = { id: randomUUID(), prompt, answers, spec, createdAt: now, updatedAt: now };
      projects.set(project.id, project);
      return clone(project);
    },
    get(id) {
      const p = projects.get(id);
      return p ? clone(p) : null;
    },
    list() {
      return [...projects.values()].map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    update(id, patch) {
      const p = projects.get(id);
      if (!p) return null;
      Object.assign(p, patch, { updatedAt: new Date().toISOString() });
      return clone(p);
    },
    remove(id) {
      workflows.delete(id);
      return projects.delete(id);
    },
  };

  const workflowRepo = {
    save(projectId, workflow) {
      workflows.set(projectId, clone(workflow));
      return clone(workflow);
    },
    getByProject(projectId) {
      const w = workflows.get(projectId);
      return w ? clone(w) : null;
    },
  };

  return { projects: projectRepo, workflows: workflowRepo };
}

const clone = (o) => JSON.parse(JSON.stringify(o));
