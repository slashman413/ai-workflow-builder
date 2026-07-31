/**
 * routes.js — the HTTP adapter. Translates requests into service calls and
 * AppErrors into status codes. It holds NO business logic; every decision lives
 * in ProjectService. Controllers never touch repositories directly (see the
 * architect rule on not bypassing use cases).
 */

import { Router } from 'express';
import { AppError } from '../../application/projectService.js';

/**
 * @param {import('../../application/projectService.js').ProjectService} service
 */
export function createRouter(service) {
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

  router.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Projects
  router.post('/projects', wrap((req) => withStatus(service.createProject(req.body?.prompt), 201)));
  router.get('/projects', wrap(() => service.listProjects()));
  router.get('/projects/:id', wrap((req) => service.getProject(req.params.id)));
  router.delete('/projects/:id', wrap((req) => service.deleteProject(req.params.id)));

  // Grill me
  router.get('/projects/:id/grill', wrap((req) => service.grill(req.params.id, { deep: req.query.deep === 'true' })));
  router.post('/projects/:id/answers', wrap((req) => service.answer(req.params.id, req.body?.answers)));

  // Workflow builder
  router.post(
    '/projects/:id/workflow/scaffold',
    wrap((req) => withStatus(service.scaffoldWorkflow(req.params.id, { force: req.body?.force === true }), 201)),
  );
  router.put('/projects/:id/workflow', wrap((req) => service.saveWorkflow(req.params.id, req.body?.workflow)));
  router.get('/projects/:id/workflow', wrap((req) => service.getWorkflow(req.params.id)));

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
