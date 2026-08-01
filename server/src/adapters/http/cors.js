/**
 * cors.js — a tiny, dependency-free CORS middleware.
 *
 * The SPA (Cloudflare Pages, workflow-builders.com) and the API
 * (api.workflow-builders.com) live on different origins in production, so the
 * browser sends cross-origin requests and requires an explicit allow-list.
 *
 * Policy:
 *   - exact allow-list: production → only `https://workflow-builders.com`
 *     (override with the comma-separated `CORS_ORIGINS` env var for
 *     staging/preview); development → the Vite dev/preview origins on
 *     localhost.
 *   - structural patterns, honored in EVERY environment:
 *       `https://*.pages.dev`            → Cloudflare Pages preview/branch
 *                                          deploys of the SPA
 *       `https://*.workflow-builders.com` → staging/custom subdomains
 *   - pre-flight `OPTIONS` requests are answered with 204 without touching
 *     the router; `Authorization` (Clerk session JWT) and `Content-Type` are
 *     explicitly allowed, and `Access-Control-Allow-Credentials: true` is set
 *     (valid because we always reflect an explicit origin, never `*`).
 *
 * Security note: CORS only governs whether a *browser* may read responses.
 * It never bypasses authentication — every business route is gated by the
 * Clerk session JWT (auth.js), so a foreign origin still gets 401 without a
 * valid token.
 *
 * We hand-roll this instead of pulling in the `cors` package to keep the
 * server's dependency surface to just Express.
 */

const PROD_ORIGINS = ['https://workflow-builders.com'];
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173', // `vite preview`
];

// Structural origin patterns (https only). Exact allow-list matches always
// win; these widen the gate for Cloudflare preview deploys and staging
// subdomains without listing every random pages.dev hash. Preview URLs look
// like `<hash>.<project>.pages.dev`, hence the optional sub-labels.
const ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.pages\.dev$/i,
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workflow-builders\.com$/i,
];

/** Resolve the exact allow-list for the current environment. */
export function allowedOrigins(env = process.env) {
  if (env.CORS_ORIGINS) {
    return env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }
  return env.NODE_ENV === 'production' ? PROD_ORIGINS : DEV_ORIGINS;
}

/** Whether a browser origin may read responses (exact match or pattern). */
export function isAllowedOrigin(origin, env = process.env) {
  if (!origin) return false;
  if (allowedOrigins(env).includes(origin)) return true;
  return ORIGIN_PATTERNS.some((re) => re.test(origin));
}

/**
 * Build an Express middleware that reflects an allowed `Origin` back and
 * short-circuits pre-flight `OPTIONS` requests with 204.
 */
export function corsMiddleware(env = process.env) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin, env)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      // Authorization (Clerk session JWT), X-Org-Id (tenant binding sent by
      // the SPA on every request), and the dev-mode identity headers.
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Org-Id, X-User-Id, X-User-Role');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    // `Origin` changes the response regardless of match, so caches must vary.
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    next();
  };
}
