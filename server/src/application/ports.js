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
 * CatalogRepository (Increment 3 — GLOBAL public MIT content, deliberately
 * NOT org-scoped; the catalog is the same for every tenant). Both adapters
 * (memory + SQLite over catalog_versions/personas/lenses) implement the
 * same contract:
 *   replaceAll(payload) -> snapshot row
 *     ATOMIC swap of one source's catalog. `payload` is the parsed catalog
 *     ({ source, version, syncedAt, divisions, tools, agents } or
 *     { source, version, syncedAt, lenses }). THROWS (before any mutation in
 *     memory; mid-transaction ROLLBACK in SQLite) when a record would
 *     violate the storage constraints (null name/description/body/division),
 *     so the last-known-good catalog stays installed. Records an 'ok'
 *     version row whose payload is the full installed catalog JSON.
 *   recordFailure(source, version, error) -> snapshot row
 *     Persist a failed sync attempt WITHOUT touching data rows — the
 *     last-known-good snapshot stays served.
 *   restore(snapshotId) -> snapshot row | null
 *     Re-install a stored 'ok' snapshot's payload (manual rollback).
 *   getSnapshot(source)        -> snapshot row | null (latest, any status)
 *   listSnapshots(source)      -> snapshot row[] (newest first, cap 20)
 *   listDivisions()            -> [{ id, label, icon?, color? }]
 *   listAgents({ division, q, limit }) -> persona rows (API shape with
 *                                full id 'agency-agents:<division>/<slug>',
 *                                version, divisionLabel, tools, body)
 *   getAgent(id)               -> persona row | null
 *   listLenses()               -> lens rows (full id 'nuwa-skill:<slug>',
 *                                version, fidelity, body)
 *   getLens(id)                -> lens row | null
 *   hasCatalog(source)         -> boolean (good data installed & served)
 *
 * Snapshot row shape: { id, source, version, status, summary, error,
 * syncedAt }.
 *
 * GrillSessionRepository counters (Increment 3 guardrails): every
 * `record(...)` call also carries `turns` and `tokensUsed` — the CUMULATIVE
 * session totals for the project — and `usage(orgId, projectId)` reads them
 * back from the latest row. The service enforces the ceilings; the store is
 * just the durable counter.
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
  CatalogRepository: 'CatalogRepository',
});
