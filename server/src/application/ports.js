/**
 * ports.js — the application's outbound ports (hexagonal architecture).
 *
 * These are documentation-only interface contracts. The application services
 * depend on the *shape* described here, never on a concrete adapter, so any
 * store (SQLite today, Postgres tomorrow, in-memory in tests) can be plugged
 * in. See docs/adr/0002.
 *
 * ProjectRepository:
 *   create({ prompt }) -> Project
 *   get(id)            -> Project | null
 *   list()             -> Project[]
 *   update(id, patch)  -> Project | null
 *   remove(id)         -> boolean
 *
 * WorkflowRepository:
 *   save(projectId, workflow) -> Workflow   // upsert
 *   getByProject(projectId)   -> Workflow | null
 *
 * A Project bundles the raw prompt, the grill answers gathered so far, and the
 * derived spec snapshot:
 *   Project = { id, prompt, answers: Record<string,string>, spec: Spec|null,
 *               createdAt, updatedAt }
 */

export const PORTS = Object.freeze({
  ProjectRepository: 'ProjectRepository',
  WorkflowRepository: 'WorkflowRepository',
});
