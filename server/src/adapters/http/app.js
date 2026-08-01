/**
 * app.js — assemble the Express app (wiring, no logic). Exported separately
 * from the listener so tests can mount it with supertest-style calls or an
 * in-memory repo without opening a socket.
 */

import express from 'express';
import { createRouter } from './routes.js';
import { corsMiddleware } from './cors.js';
import { ProjectService } from '../../application/projectService.js';

/**
 * @param {{ projects: any, workflows: any }} repos  Repository adapters (memory or sqlite).
 */
export function createApp(repos) {
  const app = express();
  // Cross-origin policy runs before anything else so pre-flight requests are
  // answered without touching the JSON parser or the router.
  app.use(corsMiddleware());
  app.use(express.json({ limit: '256kb' }));

  const service = new ProjectService(repos);
  app.use('/api', createRouter(service));

  // Fallback 404 for unknown API routes.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown endpoint.' }));

  return app;
}
