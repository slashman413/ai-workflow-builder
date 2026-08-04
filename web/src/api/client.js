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
  /** Workflow execution (Increment 5) — run, control, history, retry. */
  executions: {
    run: (projectId, inputs = {}) =>
      request(`/projects/${projectId}/run`, { method: 'POST', body: JSON.stringify({ inputs }) }),
    cancel: (projectId, execId) =>
      request(`/projects/${projectId}/run/cancel`, { method: 'POST', body: JSON.stringify({ execId }) }),
    pause: (projectId, execId) =>
      request(`/projects/${projectId}/run/pause`, { method: 'POST', body: JSON.stringify({ execId }) }),
    resume: (projectId, execId) =>
      request(`/projects/${projectId}/run/resume`, { method: 'POST', body: JSON.stringify({ execId }) }),
    retry: (projectId, execId = null) =>
      request(`/projects/${projectId}/run/retry`, { method: 'POST', body: JSON.stringify({ execId }) }),
    get: (projectId, execId) => request(`/projects/${projectId}/run/${execId}`),
    list: (projectId) => request(`/projects/${projectId}/executions`),
    /**
     * Realtime run stream (SSE via fetch — EventSource cannot send the auth
     * headers this API requires). Auto-reconnects with backoff until the
     * stream ends cleanly or `stop` is called. Returns the stop function.
     */
    stream: (projectId, execId, { onEvent, signal } = {}) => {
      let stopped = false;
      let attempts = 0;
      const controller = new AbortController();
      const stop = () => {
        stopped = true;
        controller.abort();
        signal?.removeEventListener('abort', stop);
      };
      signal?.addEventListener('abort', stop, { once: true });
      const connect = async () => {
        while (!stopped) {
          try {
            attempts += 1;
            await streamSSE(`/projects/${projectId}/run/${execId}/events`, {
              onEvent,
              signal: controller.signal,
            });
            return; // clean end of stream
          } catch (err) {
            if (stopped || controller.signal.aborted) return;
            onEvent?.('__error', { message: err instanceof Error ? err.message : String(err) });
            await new Promise((r) => setTimeout(r, Math.min(400 * attempts, 2500)));
          }
        }
      };
      connect();
      return stop;
    },
  },
  /** One-click deploy (Increment 5). */
  deploys: {
    create: (projectId, { platform = 'cloudflare', dryRun = false } = {}) =>
      request(`/projects/${projectId}/deploy`, {
        method: 'POST',
        body: JSON.stringify({ platform, dryRun }),
      }),
    list: (projectId) => request(`/projects/${projectId}/deployments`),
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

/**
 * streamSSE — consume a server-sent-events endpoint via fetch so the auth
 * headers (Bearer token, org id) are sent — EventSource cannot set headers.
 * Parses `event:` / `data:` frames and calls onEvent(eventName, payload).
 * Resolves when the stream ends; rejects on network errors (callers retry).
 */
async function streamSSE(path, { onEvent, signal } = {}) {
  const headers = { accept: 'text/event-stream' };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.orgId) headers['x-org-id'] = auth.orgId;
  const res = await fetch(BASE + path, { headers, signal });
  if (!res.ok || !res.body) {
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    throw new ApiError(res.status, body);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dispatch = (eventName, raw) => {
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* non-JSON payloads pass through as strings */
    }
    onEvent?.(eventName, data);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let eventName = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) data += `${line.slice(5).trim()}\n`;
      }
      if (data.trim()) dispatch(eventName, data.trim());
    }
  }
  onEvent?.('__end', {});
}
