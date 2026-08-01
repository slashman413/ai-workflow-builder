/**
 * client.js — a thin typed wrapper around the backend REST API.
 *
 * Keeping every fetch in one module means the components never build URLs or
 * parse errors themselves; they call intention-revealing functions and get
 * plain data or a thrown ApiError.
 *
 * Auth: the AuthProvider pushes the current session token and org into this
 * module via setAuth(). Every request then carries `Authorization: Bearer
 * <token>` (verified by the backend's Clerk choke point, which reads the
 * org_id claim) and `x-org-id` (used by the backend's dev/test mode). In
 * production Clerk mode the JWT is authoritative; in dev mode the header is.
 */

// In development the Vite dev server proxies `/api` to the backend (same
// origin, no CORS). In production the SPA is served from Cloudflare Pages at
// workflow-builders.com while the API runs on its own origin
// (api.workflow-builders.com), so the deploy injects `VITE_API_URL` at build
// time and every request is made against that absolute base.
const BASE = import.meta.env.VITE_API_URL || '/api';

let auth = { token: null, orgId: null };

/** Called by the AuthProvider whenever the session or org changes. */
export function setAuth({ token, orgId }) {
  auth = { token, orgId };
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error;
    this.details = body?.details;
  }
}

async function request(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.orgId) headers['x-org-id'] = auth.orgId;

  const res = await fetch(BASE + path, { ...options, headers });
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
  /**
   * SAFE execution preview — static DAG validation + mock-handler simulation
   * only. No user code ever executes on the server (see safety.test.js).
   */
  simulate: (workflow) => request('/workflow/simulate', { method: 'POST', body: JSON.stringify({ workflow }) }),
  /**
   * Static pre-flight AST validation (Increment 4) — cycles, reachability,
   * schema matching, tool boundaries, security boundary.
   */
  preflight: (workflow) => request('/workflow/preflight', { method: 'POST', body: JSON.stringify({ workflow }) }),
  vault: {
    list: () => request('/vault'),
    store: (payload) => request('/vault', { method: 'POST', body: JSON.stringify(payload) }),
    remove: (id) => request(`/vault/${id}`, { method: 'DELETE' }),
  },
  /** GitHub publishing (Increment 4) — OAuth connection + repo export. */
  github: {
    authUrl: (redirectUri) => {
      const qs = redirectUri ? `?redirect_uri=${encodeURIComponent(redirectUri)}` : '';
      return request(`/github/auth-url${qs}`);
    },
    status: () => request('/github/status'),
    repos: () => request('/github/repos'),
    contents: (owner, repo, path = '') =>
      request(`/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?path=${encodeURIComponent(path)}`),
    disconnect: () => request('/github/connection', { method: 'DELETE' }),
  },
  publish: (projectId, { repoName, description, private: isPrivate, branch }) =>
    request(`/projects/${projectId}/publish`, {
      method: 'POST',
      body: JSON.stringify({ repoName, description, private: isPrivate, branch }),
    }),
  publications: (projectId) => request(`/projects/${projectId}/publications`),
  /** Stripe billing + entitlements (Increment 4). */
  billing: {
    status: () => request('/billing'),
    entitlement: () => request('/billing/entitlement'),
    checkout: (tierId = 'team') =>
      request('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({
          tierId,
          successUrl: window.location.origin + '/?billing=success',
          cancelUrl: window.location.origin + '/?billing=cancelled',
        }),
      }),
    portal: () => request('/billing/portal', { method: 'POST', body: JSON.stringify({}) }),
  },
  /** Privacy-preserving analytics (Increment 4) — allowlisted server-side. */
  telemetry: {
    capture: (event, props = {}) =>
      request('/telemetry/events', { method: 'POST', body: JSON.stringify({ event, props }) }),
  },
  /** Ecosystem catalogs (Increment 3) — the Agent Marketplace + Cognitive
   * Lens selector. All read-only, global MIT data; any authenticated org.
   */
  catalog: {
    sources: () => request('/catalog'),
    divisions: () => request('/catalog/divisions'),
    agents: ({ division, q, limit } = {}) => {
      const params = new URLSearchParams();
      if (division) params.set('division', division);
      if (q) params.set('q', q);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      return request(`/catalog/agents${qs ? `?${qs}` : ''}`);
    },
    agent: (id) => request(`/catalog/agents/${encodeURIComponent(id)}`),
    lenses: () => request('/catalog/lenses'),
    lens: (id) => request(`/catalog/lenses/${encodeURIComponent(id)}`),
    /** Persona catalog grouped by division (the marketplace payload). */
    personas: () => request('/catalog/personas'),
    /** Source alias: 'agency-agents' → personas, 'nuwa-skill' → lenses. */
    source: (name) => request(`/catalog/${encodeURIComponent(name)}`),
    snapshots: (source) => request(`/catalog/snapshots?source=${encodeURIComponent(source)}`),
    /** Pinned-version report for the marketplace badges. */
    checkUpdates: () => request('/skills/check-updates'),
  },
};
