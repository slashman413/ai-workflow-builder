/**
 * oauth.js — the GitHub OAuth (OAuth2 web flow) adapter for the publisher.
 *
 * The flow is the standard SPA-safe dance:
 *
 *   1. The client asks GET /api/github/auth-url. The server creates a short-
 *      lived, single-use `state` nonce bound to the caller's org + user and
 *      returns the GitHub authorize URL with `scope=repo`.
 *   2. The client opens that URL in a popup. GitHub redirects to
 *      /api/github/callback?code=...&state=...
 *   3. The callback route (public — GitHub does not send our JWT) consumes
 *      the state nonce, exchanges the code for a token, stores the sealed
 *      token against the org, and renders a tiny HTML page that posts the
 *      outcome to `window.opener` and closes itself.
 *
 * The state store is deliberately in-memory and short-lived: a nonce is
 * single-use and expires, so a leaked callback URL cannot be replayed. In a
 * multi-instance deployment the store should move to Redis — the interface
 * here (set/get/consume) is the seam.
 */

import { randomBytes } from 'node:crypto';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** The scope the publisher requires — create repos + read the account's. */
export const REQUIRED_SCOPE = 'repo';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — plenty for a popup dance

/** Errors carrying a stable code for the HTTP adapter. */
export class OAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Build the GitHub authorize URL.
 *
 * @param {{ clientId: string, redirectUri: string, state: string,
 *           scope?: string }} params
 */
export function buildAuthorizeUrl({ clientId, redirectUri, state, scope = REQUIRED_SCOPE }) {
  if (!clientId) throw new OAuthError('OAUTH_NOT_CONFIGURED', 'GitHub OAuth is not configured (GITHUB_CLIENT_ID missing).', 503);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    allow_signup: 'false',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for a token (with built-in retry on the
 * transient 5xx the token endpoint occasionally returns).
 *
 * @param {{ clientId: string, clientSecret: string, code: string,
 *           redirectUri: string, fetchImpl?: typeof fetch }} params
 * @returns {Promise<{ access_token: string, scope: string, token_type: string }>}
 */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
  if (!clientId || !clientSecret) {
    throw new OAuthError('OAUTH_NOT_CONFIGURED', 'GitHub OAuth is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing).', 503);
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ai-workflow-builder' },
        body,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        throw new OAuthError('OAUTH_EXCHANGE_FAILED', `GitHub rejected the code exchange: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`, 400);
      }
      if (!json.access_token) throw new OAuthError('OAUTH_EXCHANGE_FAILED', 'GitHub code exchange returned no access_token.', 400);
      return json;
    } catch (err) {
      lastErr = err;
      if (err instanceof OAuthError && err.code !== 'OAUTH_NOT_CONFIGURED') throw err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
  throw lastErr ?? new OAuthError('OAUTH_EXCHANGE_FAILED', 'GitHub code exchange failed.', 400);
}

/**
 * In-memory single-use state store for the OAuth dance.
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]
 */
export function createOAuthStateStore({ ttlMs = STATE_TTL_MS } = {}) {
  /** @type {Map<string, { orgId: string, userId: string, expiresAt: number }>} */
  const store = new Map();

  const prune = () => {
    const now = Date.now();
    for (const [state, entry] of store) {
      if (entry.expiresAt < now) store.delete(state);
    }
  };

  return {
    /** Create a nonce for an org+user. Returns the opaque state string. */
    set(orgId, userId) {
      prune();
      const state = randomBytes(24).toString('hex');
      store.set(state, { orgId, userId, expiresAt: Date.now() + ttlMs });
      return state;
    },
    /** Peek without consuming (for the auth-url response). */
    has(state) {
      const entry = store.get(state);
      return Boolean(entry && entry.expiresAt >= Date.now());
    },
    /**
     * Atomically consume a nonce. Returns the binding or null when the state
     * is unknown/expired/already used. Single-use: a replayed callback URL
     * cannot re-bind.
     */
    consume(state) {
      const entry = store.get(state);
      if (!entry) return null;
      store.delete(state);
      if (entry.expiresAt < Date.now()) return null;
      return { orgId: entry.orgId, userId: entry.userId };
    },
    /** Test helper: number of live nonces. */
    size() {
      prune();
      return store.size;
    },
  };
}
