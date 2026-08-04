/**
 * app.js — assemble the Express app (wiring, no logic). Exported separately
 * from the listener so tests can mount it with supertest-style calls or an
 * in-memory repo without opening a socket.
 *
 * Increment 3 additions: CatalogService (marketplace/lenses), the realtime
 * GrillStreamService (SSE loop) and the SAFE simulate endpoint are wired
 * here; the catalog CLI owns writes to the marketplace.
 *
 * Increment 4 additions: PublishService (GitHub OAuth + repo scaffolding),
 * BillingService (Stripe), and the raw-body webhook mount — the Stripe
 * signature is verified against the RAW body, so the webhook route MUST be
 * parsed before the global express.json (parsed JSON breaks verification).
 */

import express from 'express';
import { createRouter } from './routes.js';
import { corsMiddleware } from './cors.js';
import { createAuth } from './auth.js';
import { ProjectService } from '../../application/projectService.js';
import { VaultService } from '../../application/vaultService.js';
import { CatalogService } from '../../application/catalogService.js';
import { GrillStreamService } from '../../application/grillStreamService.js';
import { PublishService } from '../../application/publishService.js';
import { BillingService } from '../../application/billingService.js';
import { EntitlementService } from '../../application/entitlementService.js';
import { TelemetryService } from '../../application/telemetryService.js';
import { ExecutionService } from '../../application/executionService.js';
import { DeployService } from '../../application/deployService.js';
import { createPosthogAdapter } from '../analytics/posthogAdapter.js';
import { createOAuthStateStore } from '../github/oauth.js';
import { createGithubClient } from '../../domain/publish/githubClient.js';
import { loadKek } from '../../domain/vault/crypto.js';
import { AppError } from '../../application/projectService.js';

/**
 * @param {{ projects: any, workflows: any, grillSessions: any, vaultKeys: any, catalog: any, billing: any, githubConnections: any, publications: any }} repos
 *   Repository adapters (memory or sqlite).
 * @param {object} [opts]
 * @param {object} [opts.auth] `{ mode: 'clerk'|'test', clerkClient? }` — see
 *   auth.js. Defaults to test mode so the pre-auth dev flow and test suite
 *   keep working without Clerk credentials.
 * @param {Buffer} [opts.kek] Environment Key Encryption Key for the vault.
 *   Defaults to loadKek() (ephemeral in dev, required in production).
 * @param {object} [opts.catalog] CatalogService options (fetcher override).
 * @param {object} [opts.grillStream] GrillStreamService options (limits).
 * @param {object} [opts.publish] PublishService overrides (client factory,
 *   oauth state store, env — tests inject these).
 * @param {object} [opts.billing] BillingService overrides (stripe client,
 *   webhook secret, env).
 * @param {object} [opts.telemetry] Telemetry overrides (adapter, salt).
 * @param {object} [opts.env] Environment snapshot (tests).
 */
export function createApp(repos, { auth = { mode: 'test' }, kek, catalog, grillStream: grillStreamOpts, publish: publishOpts, billing: billingOpts, telemetry: telemetryOpts, env = process.env } = {}) {
  const app = express();
  // Cross-origin policy runs before anything else so pre-flight requests are
  // answered without touching the JSON parser or the router.
  app.use(corsMiddleware());

  // Stripe webhook: RAW body, mounted BEFORE the global JSON parser. The
  // signature is verified against exactly what Stripe sent; the handler
  // lives inline (route-level) so the /api router stays JSON-only.
  const billingService = new BillingService(repos, { env, ...billingOpts });
  app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '128kb' }), async (req, res) => {
    try {
      const result = await billingService.handleWebhookRequest(req.body, req.headers['stripe-signature']);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof AppError) {
        res.status(err.status).json({ error: err.code, message: err.message });
      } else {
        console.error('[billing] webhook processing failed:', err);
        res.status(500).json({ error: 'WEBHOOK_PROCESSING', message: 'Webhook processing failed.' });
      }
    }
  });

  app.use(express.json({ limit: '256kb' }));

  const { requireOrg, requireRole } = createAuth(auth);
  const service = new ProjectService(repos);
  const vaultService = new VaultService(repos, { kek: kek ?? loadKek() });
  const catalogService = new CatalogService(repos, catalog);
  const grillStream = new GrillStreamService(service, grillStreamOpts);
  const publishService = new PublishService({
    service,
    catalogService,
    repos,
    oauthState: publishOpts?.oauthState ?? createOAuthStateStore(),
    createClient: publishOpts?.createClient ?? (({ token }) => createGithubClient({ token })),
    kek: kek ?? loadKek(),
    env: publishOpts?.env ?? env,
  });
  const entitlementService = new EntitlementService(repos);
  const telemetryService = new TelemetryService(repos, {
    adapter: telemetryOpts?.adapter ?? createPosthogAdapter({ apiKey: env.POSTHOG_API_KEY, host: env.POSTHOG_HOST }),
    salt: telemetryOpts?.salt ?? 'workflow-builders',
  });
  // Increment 5: the execution engine (runs the saved workflow DAG with the
  // built-in handlers) and the one-click deploy scaffold generator.
  const executionService = new ExecutionService(
    {
      service,
      entitlementService,
      vaultService,
      catalogService,
      telemetryService,
      executions: repos.executions,
      executionSteps: repos.executionSteps,
    },
    { env, options: { handlers: undefined }, dataDir: env.DATA_DIR ?? `${process.cwd()}/data/executions` },
  );
  const deployService = new DeployService(
    { service, entitlementService, deployments: repos.deployments },
    { env, baseDir: env.DEPLOY_DIR ?? `${process.cwd()}/data/deployments` },
  );

  // Readiness probe for the health endpoint: delegate to the storage
  // adapter's `ping` (SELECT 1 for SQLite, trivially ok in memory). Fall
  // back to "healthy" only if an adapter ever lacks a ping.
  const checkHealth = repos.ping ? () => repos.ping() : () => ({ ok: true, note: 'adapter without ping' });

  app.use('/api', createRouter({ service, vaultService, catalogService, grillStream, publishService, billingService, entitlementService, telemetryService, executionService, deployService, requireOrg, requireRole, checkHealth }));

  // Fallback 404 for unknown API routes.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown endpoint.' }));

  return app;
}
