/**
 * app.js — assemble the Express app (wiring, no logic). Exported separately
 * from the listener so tests can mount it with supertest-style calls or an
 * in-memory repo without opening a socket.
 *
 * Increment 3 additions: CatalogService (marketplace/lenses), the realtime
 * GrillStreamService (SSE loop) and the SAFE simulate endpoint are wired
 * here; the catalog CLI owns writes to the marketplace.
 */

import express from 'express';
import { createRouter } from './routes.js';
import { corsMiddleware } from './cors.js';
import { createAuth } from './auth.js';
import { ProjectService } from '../../application/projectService.js';
import { VaultService } from '../../application/vaultService.js';
import { CatalogService } from '../../application/catalogService.js';
import { GrillStreamService } from '../../application/grillStreamService.js';
import { loadKek } from '../../domain/vault/crypto.js';

/**
 * @param {{ projects: any, workflows: any, grillSessions: any, vaultKeys: any, catalog: any }} repos
 *   Repository adapters (memory or sqlite).
 * @param {object} [opts]
 * @param {object} [opts.auth] `{ mode: 'clerk'|'test', clerkClient? }` — see
 *   auth.js. Defaults to test mode so the pre-auth dev flow and test suite
 *   keep working without Clerk credentials.
 * @param {Buffer} [opts.kek] Environment Key Encryption Key for the vault.
 *   Defaults to loadKek() (ephemeral in dev, required in production).
 * @param {object} [opts.catalog] CatalogService options (fetcher override).
 * @param {object} [opts.grillStream] GrillStreamService options (limits).
 */
export function createApp(repos, { auth = { mode: 'test' }, kek, catalog, grillStream: grillStreamOpts } = {}) {
  const app = express();
  // Cross-origin policy runs before anything else so pre-flight requests are
  // answered without touching the JSON parser or the router.
  app.use(corsMiddleware());
  app.use(express.json({ limit: '256kb' }));

  const { requireOrg, requireRole } = createAuth(auth);
  const service = new ProjectService(repos);
  const vaultService = new VaultService(repos, { kek: kek ?? loadKek() });
  const catalogService = new CatalogService(repos, catalog);
  const grillStream = new GrillStreamService(service, grillStreamOpts);

  // Readiness probe for the health endpoint: delegate to the storage
  // adapter's `ping` (SELECT 1 for SQLite, trivially ok in memory). Fall
  // back to "healthy" only if an adapter ever lacks a ping.
  const checkHealth = repos.ping ? () => repos.ping() : () => ({ ok: true, note: 'adapter without ping' });

  app.use('/api', createRouter({ service, vaultService, catalogService, grillStream, requireOrg, requireRole, checkHealth }));

  // Fallback 404 for unknown API routes.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown endpoint.' }));

  return app;
}
