/**
 * client.js — a thin typed wrapper around the backend REST API.
 *
 * Keeping every fetch in one module means the components never build URLs or
 * parse errors themselves; they call intention-revealing functions and get
 * plain data or a thrown ApiError.
 */

// In development the Vite dev server proxies `/api` to the backend (same
// origin, no CORS). In production the SPA is served from Cloudflare Pages at
// workflow-builders.com while the API runs on its own origin
// (api.workflow-builders.com), so the deploy injects `VITE_API_URL` at build
// time and every request is made against that absolute base.
const BASE = import.meta.env.VITE_API_URL || '/api';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error;
    this.details = body?.details;
  }
}

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

export const api = {
  createProject: (prompt) => request('/projects', { method: 'POST', body: JSON.stringify({ prompt }) }),
  listProjects: () => request('/projects'),
  getProject: (id) => request(`/projects/${id}`),
  grill: (id, deep = false) => request(`/projects/${id}/grill?deep=${deep}`),
  answer: (id, answers) => request(`/projects/${id}/answers`, { method: 'POST', body: JSON.stringify({ answers }) }),
  scaffold: (id, force = false) =>
    request(`/projects/${id}/workflow/scaffold`, { method: 'POST', body: JSON.stringify({ force }) }),
  saveWorkflow: (id, workflow) =>
    request(`/projects/${id}/workflow`, { method: 'PUT', body: JSON.stringify({ workflow }) }),
  getWorkflow: (id) => request(`/projects/${id}/workflow`),
};
