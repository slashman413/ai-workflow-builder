import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigins, isAllowedOrigin, corsMiddleware } from '../src/adapters/http/cors.js';

test('production allows only the canonical domain', () => {
  assert.deepEqual(allowedOrigins({ NODE_ENV: 'production' }), ['https://workflow-builders.com']);
});

test('development allows localhost dev/preview origins', () => {
  const origins = allowedOrigins({ NODE_ENV: 'development' });
  assert.ok(origins.includes('http://localhost:5173'));
  assert.ok(!origins.includes('https://workflow-builders.com'));
});

test('CORS_ORIGINS overrides the default allow-list', () => {
  const origins = allowedOrigins({
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://workflow-builders.com, https://staging.workflow-builders.com',
  });
  assert.deepEqual(origins, [
    'https://workflow-builders.com',
    'https://staging.workflow-builders.com',
  ]);
});

// --- Preview deploys & subdomains ------------------------------------------

test('Cloudflare Pages preview deploys (*.pages.dev) are allowed in production', () => {
  const env = { NODE_ENV: 'production' };
  assert.ok(isAllowedOrigin('https://abc123def.workflow-builders.pages.dev', env));
  assert.ok(isAllowedOrigin('https://preview.ai-workflow-builder.pages.dev', env));
  assert.ok(!isAllowedOrigin('http://preview.ai-workflow-builder.pages.dev', env), 'https only');
  assert.ok(!isAllowedOrigin('https://pages.dev', env), 'bare apex does not match the subdomain pattern');
  assert.ok(!isAllowedOrigin('https://evil.com', env));
  assert.ok(!isAllowedOrigin('https://preview.ai-workflow-builder.pages.dev.evil.com', env));
});

test('workflow-builders.com subdomains are allowed (staging/preview)', () => {
  const env = { NODE_ENV: 'production' };
  assert.ok(isAllowedOrigin('https://staging.workflow-builders.com', env));
  assert.ok(isAllowedOrigin('https://preview.workflow-builders.com', env));
  assert.ok(!isAllowedOrigin('https://workflow-builders.com.evil.com', env));
  assert.ok(!isAllowedOrigin('https://workflow-builders.com', env) === false, 'apex is an exact-match, not a pattern');
});

test('disallowed origins never match, even in development', () => {
  const env = { NODE_ENV: 'development' };
  assert.ok(!isAllowedOrigin('https://evil.example.com', env));
  assert.ok(!isAllowedOrigin(undefined, env));
  assert.ok(!isAllowedOrigin('', env));
});

// --- Middleware behaviour ---------------------------------------------------

function fakeRes() {
  return {
    headers: {},
    statusCode: null,
    setHeader(k, v) { this.headers[k] = v; },
    end() { this.ended = true; },
  };
}

test('pre-flight for an allowed origin grants credentials + Authorization', () => {
  const mw = corsMiddleware({ NODE_ENV: 'production' });
  const res = fakeRes();
  mw(
    { method: 'OPTIONS', headers: { origin: 'https://workflow-builders.com', 'access-control-request-headers': 'content-type, authorization, x-org-id' } },
    res,
    () => { throw new Error('next must not run for pre-flight'); },
  );
  assert.equal(res.statusCode, 204);
  assert.ok(res.ended);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://workflow-builders.com');
  assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
  const allowed = res.headers['Access-Control-Allow-Headers'];
  assert.ok(allowed.includes('Authorization'), 'Clerk JWT header allowed');
  assert.ok(allowed.includes('Content-Type'));
  assert.ok(allowed.includes('X-Org-Id'), 'tenant header sent by the SPA must pass pre-flight');
});

test('pre-flight for a preview deploy origin is answered', () => {
  const mw = corsMiddleware({ NODE_ENV: 'production' });
  const res = fakeRes();
  mw(
    { method: 'OPTIONS', headers: { origin: 'https://abc123.ai-workflow-builder.pages.dev', 'access-control-request-method': 'POST' } },
    res,
    () => { throw new Error('next must not run for pre-flight'); },
  );
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://abc123.ai-workflow-builder.pages.dev');
});

test('pre-flight for a disallowed origin gets no CORS headers (fail closed)', () => {
  const mw = corsMiddleware({ NODE_ENV: 'production' });
  const res = fakeRes();
  mw({ method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }, res, () => { throw new Error('next must not run'); });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
});

test('allowed actual request reflects the origin and continues to the router', () => {
  const mw = corsMiddleware({ NODE_ENV: 'production' });
  const res = fakeRes();
  let called = false;
  mw({ method: 'GET', headers: { origin: 'https://workflow-builders.com' } }, res, () => { called = true; });
  assert.ok(called);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://workflow-builders.com');
  assert.equal(res.headers['Vary'], 'Origin');
});
