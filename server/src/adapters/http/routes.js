/**
 * routes.js — the HTTP adapter. Translates requests into service calls and
 * AppErrors into status codes. It holds NO business logic; every decision lives
 * in ProjectService / VaultService / CatalogService / GrillStreamService.
 * Controllers never touch repositories directly (see the architect rule on
 * not bypassing use cases).
 *
 * Tenant isolation: every secured route is wrapped by `requireOrg` (which
 * verifies the Clerk session JWT and binds `req.orgId`) and a `requireRole`
 * gate. Controllers pass `req.orgId` into every service call — the request's
 * tenant identity is never derived from the URL, the body, or headers that a
 * client controls.
 *
 * Increment 3 additions:
 *   - /catalog/*         read-only marketplace + lens endpoints (global MIT
 *                        data, any authenticated org; never mutated over HTTP)
 *   - /grill/stream      the realtime Grill-Me SSE loop (turn/token ceilings
 *                        enforced in the service layer)
 *   - /workflow/simulate the SAFE execution preview — static DAG validation
 *                        + mock-handler topological simulation only. NO user
 *                        code ever executes on this server (safety.test.js).
 */

import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { AppError } from '../../application/projectService.js';
import { simulateWorkflow } from '../../domain/executor/simulation.js';
import { STREAM_LIMITS } from '../../application/grillStreamService.js';

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
 * @param {import('../../application/catalogService.js').CatalogService} deps.catalogService
 * @param {import('../../application/grillStreamService.js').GrillStreamService} deps.grillStream
 * @param {import('./auth.js').createAuth} deps.requireOrg
 * @param {import('./auth.js').createAuth} deps.requireRole
 * @param {() => Promise<{ok: boolean, latencyMs?: number, error?: string}>} deps.checkHealth
 *   Live storage readiness probe (see app.js).
 */
export function createRouter({ service, vaultService, catalogService, grillStream, requireOrg, requireRole, checkHealth }) {
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
  //   viewer    → read-only workspace (projects, grill, workflow, catalog,
  //               simulate)
  //   architect → + create projects, answer grill, scaffold/save workflows,
  //               vault, grill stream sessions
  //   owner     → + delete projects (and vault entries)

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

  // --- Ecosystem catalogs (Increment 3) — read-only marketplace surface.
  // --- Global MIT data, any authenticated org; there is NO HTTP route that
  // --- mutates the catalog — writes are operator-only via the sync CLI
  // --- (server/src/cli/sync-catalogs.js), so a compromised session cannot
  // --- poison the marketplace.
  //
  // Route order matters: the specific collection routes MUST be registered
  // before the /catalog/:source alias below, or "divisions"/"agents"/…
  // would be swallowed by the source parameter.
  //
  //   GET /catalog                → synced sources with pinned versions
  //   GET /catalog/divisions      → division metadata (marketplace grouping)
  //   GET /catalog/agents         → personas (division / q / limit filters)
  //   GET /catalog/agents/:id     → one persona with tool permission tags
  //   GET /catalog/lenses         → cognitive perspective lenses
  //   GET /catalog/lenses/:id     → one lens (body + FIDELITY scorecard)
  //   GET /catalog/snapshots      → sync provenance (source filter)
  //   GET /catalog/personas       → personas grouped by division
  //   GET /catalog/:source        → alias: agency-agents=personas, nuwa-skill=lenses
  //   GET /skills/check-updates   → pinned-version report for the UI badges

  // List synced sources with version info
  router.get('/catalog', requireOrg, requireRole('viewer'), wrap(() => catalogService.listSources()));

  // Persona catalog grouped by division (throws CATALOG_EMPTY if not synced)
  router.get('/catalog/personas', requireOrg, requireRole('viewer'), wrap(() => catalogService.getPersonas()));

  // Division metadata (id/label/icon/color) — marketplace grouping keys
  router.get('/catalog/divisions', requireOrg, requireRole('viewer'), wrap(() =>
    catalogService.listDivisions(),
  ));

  // Personas with division + tool permission tags; ?division=, ?q=, ?limit=
  router.get('/catalog/agents', requireOrg, requireRole('viewer'), wrap((req) =>
    catalogService.listAgents({
      division: req.query.division,
      q: req.query.q,
      limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
    }),
  ));

  // One persona (tool tags + markdown body)
  router.get('/catalog/agents/:id', requireOrg, requireRole('viewer'), wrap((req) =>
    catalogService.getAgent(req.params.id),
  ));

  // Cognitive perspective lenses (bare collection)
  router.get('/catalog/lenses', requireOrg, requireRole('viewer'), wrap(() => catalogService.getLenses()));

  // One lens (body + FIDELITY scorecard when present)
  router.get('/catalog/lenses/:id', requireOrg, requireRole('viewer'), wrap((req) =>
    catalogService.getLens(req.params.id),
  ));

  // Sync provenance: /catalog/snapshots?source=agency-agents
  router.get('/catalog/snapshots', requireOrg, requireRole('viewer'), wrap((req) =>
    catalogService.listSnapshots(req.query.source),
  ));

  // Source alias — registered LAST so it never shadows the routes above.
  // GET /catalog/agency-agents → persona marketplace; /catalog/nuwa-skill → lenses
  router.get('/catalog/:source', requireOrg, requireRole('viewer'), wrap((req) => catalogService.getCatalog(req.params.source)));

  // Update check: report per-source staleness (drives the version badges)
  router.get('/skills/check-updates', requireOrg, requireRole('viewer'), wrap(() => catalogService.checkUpdates()));

  // --- Realtime Grill-Me loop via SSE (Increment 3) ------------------------
  // POST /grill/stream opens (or resumes) the interrogation stream. The
  // response is text/event-stream; the client answers through
  // POST /grill/stream/:sessionId/answers. Turn/token ceilings (5 turns /
  // 15,000 tokens) are enforced in the SERVICE layer and mirrored here for
  // live `limit` events — they can never be raised by the client.
  const sseHeaders = (res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx/Cloudflare)
    });
    res.write(': connected\n\n');
    return res;
  };

  router.post('/grill/stream', requireOrg, requireRole('architect'), (req, res) => {
    // Pre-flight BEFORE committing SSE headers so bad requests get proper
    // JSON status codes instead of a half-open stream.
    try {
      if (req.body?.sessionId) {
        grillStream.peek(req.orgId, String(req.body.sessionId));
      } else {
        if (typeof req.body?.prompt !== 'string' || !req.body.prompt.trim()) {
          throw new AppError('INVALID_PROMPT', 'prompt must be a non-empty string.', 400);
        }
        if (grillStream.activeCount(req.orgId) >= STREAM_LIMITS.maxActiveSessionsPerOrg) {
          throw new AppError('TOO_MANY_SESSIONS', 'Too many active grill sessions for this workspace.', 429);
        }
      }
    } catch (err) {
      if (err instanceof AppError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      console.error(err);
      return res.status(500).json({ error: 'INTERNAL', message: 'Unexpected server error.' });
    }

    sseHeaders(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);
    res.on('close', () => clearInterval(heartbeat));

    try {
      grillStream.open({
        orgId: req.orgId,
        prompt: req.body?.prompt,
        projectId: req.body?.projectId ? String(req.body.projectId) : undefined,
        sessionId: req.body?.sessionId ? String(req.body.sessionId) : undefined,
        res,
      });
    } catch (err) {
      // Post-header failure: surface as an SSE error event, then end.
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: err?.code ?? 'INTERNAL', message: err?.message ?? String(err) })}\n\n`);
      } catch {
        /* client already gone */
      }
      res.end();
    }
  });

  router.post('/grill/stream/:sessionId/answers', requireOrg, requireRole('architect'), (req, res) => {
    try {
      const result = grillStream.answer(req.orgId, req.params.sessionId, {
        answerId: req.body?.answerId,
        text: req.body?.text,
      });
      if (result.error === 'GRILL_LIMIT') {
        return res.status(429).json(result);
      }
      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof AppError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      console.error(err);
      return res.status(500).json({ error: 'INTERNAL', message: 'Unexpected server error.' });
    }
  });

  router.get('/grill/stream/:sessionId', requireOrg, requireRole('viewer'), wrap((req) =>
    grillStream.state(req.orgId, req.params.sessionId),
  ));

  // --- SAFE execution preview (Increment 3) --------------------------------
  // Static DAG validation + mock-handler topological simulation. This is the
  // ONLY "execution" surface, and it is provably inert: the simulation
  // module accepts no handlers and performs zero I/O (see safety.test.js).
  router.post('/workflow/simulate', requireOrg, requireRole('viewer'), async (req, res) => {
    try {
      const result = await simulateWorkflow(req.body?.workflow);
      res.status(200).json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'INTERNAL', message: 'Unexpected server error.' });
    }
  });

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
