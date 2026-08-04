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
import { preflightWorkflow } from '../../domain/workflow/preflight.js';
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
 * @param {import('../../application/publishService.js').PublishService} deps.publishService
 * @param {import('../../application/billingService.js').BillingService} deps.billingService
 * @param {import('../../application/entitlementService.js').EntitlementService} deps.entitlementService
 * @param {import('../../application/telemetryService.js').TelemetryService} deps.telemetryService
 * @param {import('../../application/executionService.js').ExecutionService} deps.executionService
 * @param {import('../../application/deployService.js').DeployService} deps.deployService
 * @param {import('./auth.js').createAuth} deps.requireOrg
 * @param {import('./auth.js').createAuth} deps.requireRole
 * @param {() => Promise<{ok: boolean, latencyMs?: number, error?: string}>} deps.checkHealth
 *   Live storage readiness probe (see app.js).
 */
export function createRouter({ service, vaultService, catalogService, grillStream, publishService, billingService, entitlementService, telemetryService, executionService, deployService, requireOrg, requireRole, checkHealth }) {
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

  // Async twin of `wrap` for the async service calls (publish, billing, github).
  const wrapAsync = (fn) => (req, res) => {
    fn(req)
      .then((body) => res.status(body?.__status ?? 200).json(strip(body)))
      .catch((err) => {
        if (err instanceof AppError) {
          res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
        } else {
          console.error(err);
          res.status(500).json({ error: 'INTERNAL', message: 'Unexpected server error.' });
        }
      });
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
        // Increment 4 quota gate: free tier is capped at 10 Grill sessions /
        // month; Team/trial is unlimited. Throws 402 QUOTA_EXCEEDED before
        // any SSE headers are committed.
        entitlementService.assertGrillQuota(req.orgId);
        telemetryService.capture(req.orgId, 'grill_session_started', {
          tier: entitlementService.resolveTier(req.orgId),
        });
      }
    } catch (err) {
      if (err instanceof AppError) {
        return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
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
  // Increment 4: the response carries the entitlement preview mode — Free
  // tier sees `mock` (mocked preview), Team/trial sees `simulated`.
  router.post('/workflow/simulate', requireOrg, requireRole('viewer'), async (req, res) => {
    try {
      const result = await simulateWorkflow(req.body?.workflow);
      result.preview = entitlementService.previewMode(req.orgId);
      res.status(200).json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'INTERNAL', message: 'Unexpected server error.' });
    }
  });

  // --- Static Pre-Flight AST validation (Increment 4) ----------------------
  // The full static gate run before ANY publish: structural DAG checks,
  // schema parameter matching, tool-boundary constraints against the
  // marketplace catalog, and the security boundary reassertion. Pure static
  // analysis — nothing is executed (see preflight.js + safety.test.js).
  router.post('/workflow/preflight', requireOrg, requireRole('viewer'), wrap((req) =>
    preflightWorkflow(req.body?.workflow ?? null, catalogService.preflightContext()),
  ));

  // --- GitHub publishing + repository scraper (Increment 4) ----------------
  // The OAuth dance: GET /github/auth-url (secured) hands the client a
  // GitHub authorize URL; GitHub redirects to GET /github/callback (PUBLIC —
  // GitHub carries no session token; the single-use state nonce binds the
  // callback to the org that started it), which exchanges the code, stores
  // the sealed token, and postMessages the result back to the opener popup.
  // 401/403 from GitHub map to GITHUB_AUTH_REQUIRED so the UI can prompt an
  // inline re-authentication without discarding the pending publish.

  router.get('/github/auth-url', requireOrg, requireRole('architect'), wrap((req) => {
    const { url } = publishService.authUrl({ orgId: req.orgId, userId: req.auth?.userId, redirectUri: req.query.redirect_uri });
    return { url };
  }));

  router.get('/github/callback', async (req, res) => {
    try {
      const result = await publishService.completeOAuth({
        code: String(req.query.code ?? ''),
        state: String(req.query.state ?? ''),
        redirectUri: req.query.redirect_uri,
      });
      res.type('html').send(oauthCallbackHtml({ ok: true, login: result.login }));
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'OAUTH_FAILED';
      const message = err instanceof AppError ? err.message : String(err);
      res.status(err instanceof AppError ? err.status : 500).type('html').send(oauthCallbackHtml({ ok: false, error: code, message }));
    }
  });

  router.get('/github/status', requireOrg, requireRole('viewer'), wrap((req) => publishService.status(req.orgId)));

  router.get('/github/repos', requireOrg, requireRole('architect'), wrapAsync((req) => publishService.listRepos(req.orgId)));

  router.get('/github/repos/:owner/:repo/contents', requireOrg, requireRole('viewer'), wrapAsync((req) =>
    publishService.getContents(req.orgId, { owner: req.params.owner, repo: req.params.repo, path: String(req.query.path ?? '') }),
  ));

  router.delete('/github/connection', requireOrg, requireRole('owner'), wrap((req) => publishService.disconnect(req.orgId)));

  // Publish: pre-flight → codegen → scaffold → create repo → push. The
  // <5s SLA is enforced by the git-data push path (4 requests) and recorded
  // on every publication for ops monitoring.
  // Increment 4: the Team/trial entitlement gate runs FIRST — Free tier gets
  // HTTP 402 PAYMENT_REQUIRED and the export is never attempted.
  router.post('/projects/:id/publish', requireOrg, requireRole('architect'), wrapAsync(async (req) => {
    const entitlement = entitlementService.assertExportAllowed(req.orgId);
    try {
      const result = await publishService.publish(req.orgId, req.params.id, {
        repoName: req.body?.repoName,
        description: req.body?.description,
        private: req.body?.private !== false,
        branch: req.body?.branch,
      });
      telemetryService.capture(req.orgId, 'export_completed', {
        mode: 'live',
        tier: entitlement.tier,
        count: result.fileCount,
        durationMs: result.latencyMs,
        repoPrivate: req.body?.private !== false,
        branch: result.branch,
        outcome: 'ok',
      });
      return result;
    } catch (err) {
      if (err instanceof AppError) {
        telemetryService.capture(req.orgId, 'export_blocked', {
          tier: entitlement.tier,
          reason: err.code,
          outcome: 'blocked',
        });
      }
      throw err;
    }
  }));

  router.get('/projects/:id/publications', requireOrg, requireRole('viewer'), wrap((req) =>
    publishService.listPublications(req.orgId, req.params.id),
  ));

  // --- Stripe billing (Increment 4) ----------------------------------------
  // POST /api/billing/webhook is mounted on the APP (not here) so it can
  // parse the RAW body before express.json — see app.js.
  router.get('/billing', requireOrg, requireRole('viewer'), wrap((req) => billingService.getBilling(req.orgId)));

  // Effective entitlement + usage for the current billing period — the data
  // behind the plan badge and the quota gates (Free: 10 Grill/month, mock
  // previews, no export; Team/trial: unlimited).
  router.get('/billing/entitlement', requireOrg, requireRole('viewer'), wrap((req) =>
    entitlementService.entitlement(req.orgId),
  ));

  router.post('/billing/checkout', requireOrg, requireRole('architect'), wrapAsync(async (req) => {
    const result = await billingService.createCheckoutSession(req.orgId, {
      successUrl: req.body?.successUrl,
      cancelUrl: req.body?.cancelUrl,
      tierId: req.body?.tierId,
    });
    telemetryService.capture(req.orgId, 'checkout_started', {
      tier: req.body?.tierId ?? 'team',
      mode: billingService.isConfigured() ? 'live' : 'mock',
      outcome: 'ok',
    });
    return result;
  }));

  router.post('/billing/portal', requireOrg, requireRole('architect'), wrapAsync((req) =>
    billingService.createPortalLink(req.orgId, { returnUrl: req.body?.returnUrl }),
  ));

  // --- Privacy-preserving analytics (Increment 4) --------------------------
  // Client-side capture endpoint (lens selections, agent drops). The server
  // allowlists every property and pseudonymizes the org — prompt text, API
  // keys, or any free-form content is structurally impossible to log here
  // (see telemetryService.js).
  router.post('/telemetry/events', requireOrg, requireRole('viewer'), wrap((req) => {
    const { event, props } = req.body ?? {};
    if (typeof event !== 'string' || !event.trim()) {
      throw new AppError('INVALID_EVENT', 'event must be a non-empty string.', 400);
    }
    telemetryService.capture(req.orgId, event, { ...(props ?? {}), tier: entitlementService.resolveTier(req.orgId) });
    return { captured: true, event };
  }));

  // --- Workflow execution (Increment 5) -------------------------------------
  // The production runtime: POST /projects/:id/run executes the SAVED
  // workflow through the built-in handlers (input/agent/tool/branch/output).
  // Agent keys come from the vault; Free plan is rejected with 402 before any
  // run state is created. Progress streams over SSE at
  // GET /projects/:id/run/:execId/events (fetch-based streaming — the client
  // sends auth headers, so EventSource is not used).
  //
  // Route order matters: the specific /run/cancel|pause|resume|retry routes
  // MUST be registered before /run/:execId or 'cancel' would be captured as
  // an execution id.
  router.post('/projects/:id/run', requireOrg, requireRole('architect'), wrapAsync(async (req) => {
    const execution = executionService.start(req.orgId, req.params.id, { inputs: req.body?.inputs });
    return withStatus(execution, 201);
  }));

  router.post('/projects/:id/run/cancel', requireOrg, requireRole('architect'), wrap((req) =>
    executionService.cancel(req.orgId, req.params.id, req.body?.execId),
  ));

  router.post('/projects/:id/run/pause', requireOrg, requireRole('architect'), wrap((req) =>
    executionService.pause(req.orgId, req.params.id, req.body?.execId),
  ));

  router.post('/projects/:id/run/resume', requireOrg, requireRole('architect'), wrap((req) =>
    executionService.resume(req.orgId, req.params.id, req.body?.execId),
  ));

  // Re-run the latest (or a named) finished execution as a NEW run linked
  // via retryOf — history stays append-only.
  router.post('/projects/:id/run/retry', requireOrg, requireRole('architect'), wrapAsync((req) => {
    const execution = executionService.retry(req.orgId, req.params.id, { execId: req.body?.execId ?? null });
    return withStatus(execution, 201);
  }));

  router.get('/projects/:id/executions', requireOrg, requireRole('viewer'), wrap((req) =>
    executionService.list(req.orgId, req.params.id),
  ));

  router.get('/projects/:id/run/:execId', requireOrg, requireRole('viewer'), wrap((req) =>
    executionService.get(req.orgId, req.params.id, req.params.execId),
  ));

  // Real-time run stream (SSE). Replays the current state first, then pushes
  // step/execution events as the engine logs them.
  router.get('/projects/:id/run/:execId/events', requireOrg, requireRole('viewer'), (req, res) => {
    let execution;
    try {
      execution = executionService.get(req.orgId, req.params.id, req.params.execId);
    } catch (err) {
      if (err instanceof AppError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
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

    const send = (event) => {
      try {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      } catch {
        /* client gone */
      }
    };

    // Replay: the full current snapshot (execution + steps) first.
    send({ type: 'execution', data: execution });
    for (const step of execution.steps ?? []) send({ type: 'step', data: step });

    const subscriber = executionService.subscribe(req.params.execId, send);
    res.on('close', () => executionService.unsubscribe(req.params.execId, subscriber));
  });

  // --- One-click deploy (Increment 5) ---------------------------------------
  // POST /projects/:id/deploy generates the platform scaffold (wrangler.toml
  // / fly.toml / Dockerfile), assigns a deterministic URL, and records the
  // deployment. dryRun=true returns the preview without writing files and
  // marks the row status `dry_run`. Team/trial only (Free → 402).
  router.post('/projects/:id/deploy', requireOrg, requireRole('architect'), wrapAsync((req) => {
    const deployment = deployService.deploy(req.orgId, req.params.id, {
      platform: req.body?.platform ?? 'cloudflare',
      dryRun: req.body?.dryRun === true,
    });
    telemetryService.capture(req.orgId, 'deployment_created', {
      tier: entitlementService.resolveTier(req.orgId),
      mode: req.body?.dryRun === true ? 'dry_run' : 'live',
      outcome: 'ok',
    });
    return withStatus(deployment, 201);
  }));

  router.get('/projects/:id/deployments', requireOrg, requireRole('viewer'), wrap((req) =>
    deployService.list(req.orgId, req.params.id),
  ));

  return router;
}

/** The popup-closing postMessage page the OAuth callback renders. */
function oauthCallbackHtml({ ok, login = null, error = null, message = null }) {
  const payload = JSON.stringify({ source: 'workflow-builders-github', ok, login, error, message });
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GitHub connection</title></head>
<body>
<script>
  (function () {
    var payload = ${payload};
    try {
      if (window.opener) window.opener.postMessage(payload, '*');
    } catch (e) { /* opener closed — nothing we can do */ }
    window.close();
  })();
</script>
<p>You can close this window.</p>
</body></html>`;
}

const withStatus = (body, status) => ({ ...body, __status: status });
const strip = (body) => {
  if (body && typeof body === 'object' && '__status' in body) {
    const { __status, ...rest } = body;
    return rest;
  }
  return body;
};
