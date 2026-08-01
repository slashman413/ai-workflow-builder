/**
 * routes.js — the HTTP adapter. Translates requests into service calls and
 * AppErrors into status codes. It holds NO business logic; every decision lives
 * in ProjectService / VaultService. Controllers never touch repositories
 * directly (see the architect rule on not bypassing use cases).
 *
 * Tenant isolation: every secured route is wrapped by `requireOrg` (which
 * verifies the Clerk session JWT and binds `req.orgId`) and a `requireRole`
 * gate. Controllers pass `req.orgId` into every service call — the request's
 * tenant identity is never derived from the URL, the body, or headers that a
 * client controls.
 */

import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { AppError } from '../../application/projectService.js';

// Read the service identity once at load time so the health probe stays a pure
// in-memory response (no filesystem hit per request). Falls back gracefully if
// the manifest can't be read.
const SERVICE = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url)));
    return { name: pkg.name, version: pkg.version };
  } catch {
    return { name: 'ai-workflow-builder-server', version: 'unknown' };
  }
})();

/**
 * @param {object} deps
 * @param {import('../../application/projectService.js').ProjectService} deps.service
 * @param {import('../../application/vaultService.js').VaultService} deps.vaultService
 * @param {import('./auth.js').createAuth} deps.requireOrg
 * @param {import('./auth.js').createAuth} deps.requireRole
 * @param {() => Promise<{ok: boolean, latencyMs?: number, error?: string}>} deps.checkHealth
 *   Live storage readiness probe (see app.js).
 */
export function createRouter({ service, vaultService, requireOrg, requireRole, checkHealth }) {
  const router = Router();

  const wrap = (fn) => (req, res) => {
    try {
      const body = fn(req);
      res.status(body?.__status ?? 200).json(strip(body));
    } catch (err) {
      if (err instanceof AppError) {
        res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      } else {
        // Unexpected: log server-side, don't leak internals to the client.
        console.error(err);
        res.status(500).json({ error: 'INTERNAL', message: 'Unexpected server error.' });
      }
    }
  };

  // Liveness/readiness probe — deliberately public (no org binding): the
  // orchestrator, Docker HEALTHCHECK, Fly.io/Railway rolling deploys, and the
  // Cloudflare edge must be able to check it without a session. Answers 503
  // (status `degraded`) when the database is unreachable so the platform
  // restarts or fails the instance over instead of routing traffic to a
  // half-dead pod.
  router.get('/health', async (_req, res) => {
    let db;
    try {
      db = await checkHealth();
    } catch (err) {
      db = { ok: false, error: err.message };
    }
    res.status(db.ok ? 200 : 503).json({
      status: db.ok ? 'ok' : 'degraded',
      service: SERVICE.name,
      version: SERVICE.version,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      db,
    });
  });

  // --- Secured surface: everything below the health probe requires a valid
  // --- org-bound Clerk session (`requireOrg`) plus the role gate. ---------
  //
  // RBAC matrix:
  //   viewer    → read-only workspace (projects, grill, workflow)
  //   architect → + create projects, answer grill, scaffold/save workflows
  //   owner     → + delete projects (and vault entries)
  //   vault     → architect+ reads/writes; owner-only deletes.

  // Projects
  router.post('/projects', requireOrg, requireRole('architect'), wrap((req) => withStatus(service.createProject(req.orgId, req.body?.prompt), 201)));
  router.get('/projects', requireOrg, requireRole('viewer'), wrap((req) => service.listProjects(req.orgId)));
  router.get('/projects/:id', requireOrg, requireRole('viewer'), wrap((req) => service.getProject(req.orgId, req.params.id)));
  router.delete('/projects/:id', requireOrg, requireRole('owner'), wrap((req) => service.deleteProject(req.orgId, req.params.id)));

  // Grill me
  router.get('/projects/:id/grill', requireOrg, requireRole('viewer'), wrap((req) => service.grill(req.orgId, req.params.id, { deep: req.query.deep === 'true' })));
  router.post('/projects/:id/answers', requireOrg, requireRole('architect'), wrap((req) => service.answer(req.orgId, req.params.id, req.body?.answers)));

  // Workflow builder
  router.post(
    '/projects/:id/workflow/scaffold',
    requireOrg,
    requireRole('architect'),
    wrap((req) => withStatus(service.scaffoldWorkflow(req.orgId, req.params.id, { force: req.body?.force === true }), 201)),
  );
  router.put('/projects/:id/workflow', requireOrg, requireRole('architect'), wrap((req) => service.saveWorkflow(req.orgId, req.params.id, req.body?.workflow)));
  router.get('/projects/:id/workflow', requireOrg, requireRole('viewer'), wrap((req) => service.getWorkflow(req.orgId, req.params.id)));

  // Envelope-encrypted LLM key vault (never returns plaintext — see VaultService)
  router.get('/vault', requireOrg, requireRole('architect'), wrap((req) => vaultService.list(req.orgId)));
  router.post('/vault', requireOrg, requireRole('architect'), wrap((req) => withStatus(vaultService.store(req.orgId, req.body), 201)));
  router.get('/vault/:id', requireOrg, requireRole('architect'), wrap((req) => vaultService.get(req.orgId, req.params.id)));
  router.delete('/vault/:id', requireOrg, requireRole('owner'), wrap((req) => vaultService.remove(req.orgId, req.params.id)));

  return router;
}

const withStatus = (body, status) => ({ ...body, __status: status });
const strip = (body) => {
  if (body && typeof body === 'object' && '__status' in body) {
    const { __status, ...rest } = body;
    return rest;
  }
  return body;
};
