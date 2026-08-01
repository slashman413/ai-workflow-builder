/**
 * ports.js — the application's outbound ports (hexagonal architecture).
 *
 * These are documentation-only interface contracts. The application services
 * depend on the *shape* described here, never on a concrete adapter, so any
 * store (SQLite today, Postgres tomorrow, in-memory in tests) can be plugged
 * in. See docs/adr/0002.
 *
 * Multi-tenant scoping (Increment 2): every method takes the owning `orgId`
 * as its first argument. Adapters MUST scope every query by org — a row that
 * belongs to another tenant is indistinguishable from a missing row (null /
 * empty list). This is what turns cross-tenant access into HTTP 404.
 *
 * ProjectRepository:
 *   create({ orgId, prompt, answers, spec }) -> Project
 *   get(orgId, id)          -> Project | null
 *   list(orgId)             -> Project[]       // org-scoped, recency first
 *   update(orgId, id, patch)-> Project | null
 *   remove(orgId, id)       -> boolean
 *
 * WorkflowRepository:
 *   save(orgId, projectId, workflow) -> Workflow | null  // upsert; refuses
 *                                                          // cross-tenant
 *                                                          // overwrite
 *   getByProject(orgId, projectId)   -> Workflow | null
 *
 * GrillSessionRepository:
 *   record(orgId, projectId, { round, answers, coverage, ready }) -> Session
 *   listByProject(orgId, projectId)  -> Session[]   // ascending round
 *   getLatest(orgId, projectId)      -> Session | null
 *
 * VaultKeyRepository (write-only blobs; the service owns key material):
 *   insert(record)                   -> record
 *   listByOrg(orgId)                 -> record[]
 *   getByOrg(orgId, id)              -> record | null
 *   getByKeyHandle(orgId, keyHandle) -> record | null
 *   removeByOrg(orgId, id)           -> boolean
 *
 * HealthCheck (optional but expected on the repos bundle):
 *   ping() -> { ok: boolean, latencyMs?: number, error?: string }
 *     Live readiness probe for GET /api/health. Must never throw: a broken
 *     store returns { ok: false, error } so the endpoint can answer 503.
 *
 * A Project bundles the raw prompt, the grill answers gathered so far, and the
 * derived spec snapshot:
 *   Project = { id, orgId, prompt, answers: Record<string,string>,
 *               spec: Spec|null, createdAt, updatedAt }
 */

export const PORTS = Object.freeze({
  ProjectRepository: 'ProjectRepository',
  WorkflowRepository: 'WorkflowRepository',
  GrillSessionRepository: 'GrillSessionRepository',
  VaultKeyRepository: 'VaultKeyRepository',
});
