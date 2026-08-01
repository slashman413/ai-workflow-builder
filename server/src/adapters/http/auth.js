/**
 * auth.js — the backend authorization choke point (Increment 2).
 *
 * Every secured route in routes.js passes through `requireOrg` before the
 * controller runs. It:
 *
 *   1. extracts the session JWT from the `Authorization: Bearer …` header,
 *   2. cryptographically verifies it via Clerk's backend SDK
 *      (`clerkClient.authenticateRequest` — JWKS signature check, expiry,
 *      session revocation),
 *   3. extracts the `org_id` claim and binds the tenant identity to the
 *      request (`req.orgId`), plus the user id and org role (`req.auth`),
 *   4. rejects unauthenticated requests with 401 and authenticated-but-
 *      org-less requests with 403 (a session must be bound to an
 *      organization to touch tenant data).
 *
 * `requireRole` layers RBAC on top: Owner (3) > Architect (2) > Viewer (1).
 * The `org_role` claim arrives as Clerk's `org:<role>`; unknown roles map to
 * level 0 (no access) so a misconfigured role fails closed.
 *
 * Two modes (dependency-injected, so tests never need Clerk credentials):
 *   - mode 'clerk': real JWT verification through the injected clerkClient.
 *   - mode 'test' : header-based identity for CI/dev
 *     (`x-org-id`, `x-user-id`, `x-user-role`), with a stable default org so
 *     the pre-auth suite keeps running. Production never runs in this mode.
 */

import { createClerkClient } from '@clerk/backend';

/** RBAC levels: Owner > Architect > Viewer. */
export const ROLES = Object.freeze({
  owner: 3,
  architect: 2,
  viewer: 1,
});

/** Map Clerk org_role claims onto the application roles. Unknown → 0. */
const ROLE_CLAIM_TO_NAME = Object.freeze({
  'org:owner': 'owner',
  'org:admin': 'owner',
  'org:architect': 'architect',
  'org:editor': 'architect',
  'org:viewer': 'viewer',
  'org:member': 'viewer',
});

export function roleLevel(roleClaim) {
  const name = ROLE_CLAIM_TO_NAME[roleClaim];
  return name ? ROLES[name] : 0;
}

const bearerToken = (req) => {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
};

const unauthorized = (res, message) =>
  res.status(401).json({ error: 'UNAUTHENTICATED', message });

/**
 * Resolve the auth mode from the environment, failing closed in production.
 *
 * - AUTH_MODE wins when set.
 * - Otherwise the presence of CLERK_SECRET_KEY opts in to 'clerk'.
 * - Header-based test mode is FORBIDDEN under NODE_ENV=production: a deploy
 *   that forgets the Clerk secret must refuse to boot rather than silently
 *   trust client-supplied x-org-id headers against production data.
 */
export function resolveAuthMode(env = process.env) {
  const mode = env.AUTH_MODE ?? (env.CLERK_SECRET_KEY ? 'clerk' : 'test');
  if (mode === 'test' && env.NODE_ENV === 'production') {
    throw new Error('AUTH_MODE=clerk (with CLERK_SECRET_KEY) is required in production — refusing to start with header-based test auth.');
  }
  return mode;
}

/**
 * Build the auth middleware stack for the app.
 *
 * @param {object} [opts]
 * @param {'clerk'|'test'} [opts.mode]
 * @param {object} [opts.clerkClient] Clerk backend client (mode 'clerk').
 *   Injected so tests can substitute a stub; production passes the real
 *   `createClerkClient({ secretKey })`.
 */
export function createAuth({ mode = 'test', clerkClient = null } = {}) {
  if (mode === 'clerk' && !clerkClient) {
    // Create the default client from the environment. Fails fast (no lazy
    // 500s at request time) if the secret is missing.
    if (!process.env.CLERK_SECRET_KEY) {
      throw new Error('AUTH_MODE=clerk requires CLERK_SECRET_KEY (createClerkClient secretKey).');
    }
    clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  }

  /** Choke point: verify the session, extract org_id, bind req.orgId. */
  const requireOrg = async (req, res, next) => {
    if (mode === 'clerk') {
      const token = bearerToken(req);
      if (!token) return unauthorized(res, 'Missing session token. Sign in to continue.');

      let state;
      try {
        state = await clerkClient.authenticateRequest({ headerToken: token });
      } catch (err) {
        // Verification failure (bad signature, clock skew, network) — treat
        // as unauthenticated, never as a 500 that leaks internals.
        console.error('[auth] token verification failed:', err.message);
        return unauthorized(res, 'Session token could not be verified.');
      }
      if (state.status !== 'signed-in') {
        return unauthorized(res, 'Session is not signed in.');
      }
      const claims = state.claims ?? {};
      const orgId = claims.org_id;
      if (typeof orgId !== 'string' || orgId === '') {
        return res
          .status(403)
          .json({ error: 'ORG_REQUIRED', message: 'Session is not bound to an organization. Select a workspace first.' });
      }
      req.orgId = orgId;
      req.auth = { userId: claims.sub, role: roleLevel(claims.org_role), roleClaim: claims.org_role, claims };
      return next();
    }

    // Test/dev mode: identity from headers with a stable default org.
    req.orgId = req.headers['x-org-id'] || 'dev-org';
    const roleClaim = req.headers['x-user-role'] || 'org:owner';
    req.auth = {
      userId: req.headers['x-user-id'] || 'user_test',
      role: roleLevel(roleClaim),
      roleClaim,
    };
    return next();
  };

  /** RBAC gate: require at least `minRole` ('owner' | 'architect' | 'viewer'). */
  const requireRole = (minRole) => {
    const minLevel = ROLES[minRole];
    if (minLevel === undefined) throw new Error(`Unknown role: ${minRole}`);
    return (req, res, next) => {
      if (!req.auth) return unauthorized(res, 'Authentication required.');
      if (req.auth.role < minLevel) {
        return res
          .status(403)
          .json({ error: 'FORBIDDEN', message: `This action requires the ${minRole} role or higher.` });
      }
      return next();
    };
  };

  return { requireOrg, requireRole };
}
