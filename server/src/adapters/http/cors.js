/**
 * cors.js — a tiny, dependency-free CORS middleware.
 *
 * The SPA (Cloudflare Pages, workflow-builders.com) and the API
 * (api.workflow-builders.com) live on different origins in production, so the
 * browser sends cross-origin requests and requires an explicit allow-list.
 *
 * Policy:
 *   - production  → only `https://workflow-builders.com` (override with the
 *                   comma-separated `CORS_ORIGINS` env var for staging/preview).
 *   - development → the Vite dev server origins on localhost, so a browser
 *                   hitting the API directly (bypassing the proxy) still works.
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

/** Resolve the allow-list for the current environment. */
export function allowedOrigins(env = process.env) {
  if (env.CORS_ORIGINS) {
    return env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }
  return env.NODE_ENV === 'production' ? PROD_ORIGINS : DEV_ORIGINS;
}

/**
 * Build an Express middleware that reflects an allowed `Origin` back and
 * short-circuits pre-flight `OPTIONS` requests with 204.
 */
export function corsMiddleware(env = process.env) {
  const allowed = new Set(allowedOrigins(env));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
