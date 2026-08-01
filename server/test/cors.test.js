import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigins } from '../src/adapters/http/cors.js';

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
