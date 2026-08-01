/**
 * contract.test.js — the drift guard.
 *
 * `openapi.yaml` is the published API contract; the Express router is the real
 * implementation. History shows these two silently diverge (the contract once
 * documented a `/api/v1/agents` FastAPI surface that no longer exists). This
 * test fails CI the moment they disagree, in EITHER direction:
 *
 *   - a route added to routes.js but not to openapi.yaml, or
 *   - a path/operation left in openapi.yaml after the route was removed.
 *
 * It introspects the *live* Express app (not the source text) so it reflects
 * what the server actually serves, and validates the spec structurally with
 * the `yaml` package (already a runtime dependency of the server). It also
 * locks the security semantics: the only operations allowed to be public
 * (`security: []`) are the three routes registered WITHOUT the `requireOrg`
 * choke point — any new public route is a security decision that must be
 * reviewed and added to the allowlist below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';

// The contract check needs express (createApp). On a bare checkout without
// `npm install`, skip rather than fail — mirrors http.test.js.
let createApp;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
} catch {
  createApp = null;
}

const OPENAPI_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

/** `/projects/:id` (Express) → `/projects/{id}` (OpenAPI). */
const normalize = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/**
 * Parse openapi.yaml once per test. Throws loudly if the YAML itself is
 * broken, which is exactly the kind of rot this file exists to catch.
 */
function specDoc() {
  return YAML.parse(readFileSync(OPENAPI_PATH, 'utf8'));
}

/** `METHOD /path` strings from the parsed `paths:` block. */
function operationsFromSpec(doc) {
  const ops = new Set();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item[method]) ops.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return ops;
}

/**
 * Walk a mounted app/router's layer stack and yield `METHOD /api/path` strings.
 * Every route lives under the single `/api` mount, so we prefix that constant
 * (its value is asserted independently by http.test.js hitting `/api/...`).
 */
function routesFromApp(app) {
  const found = new Set();
  const visit = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const path = normalize(prefix + layer.route.path);
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) found.add(`${method.toUpperCase()} ${path}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        visit(layer.handle.stack, prefix + '/api');
      }
    }
  };
  visit(app._router.stack, '');
  return found;
}

/** Resolve a `#/components/responses/X` ref against the components map. */
function resolveResponse(responses, ref) {
  const key = ref.split('/').pop();
  return responses[key];
}

const maybe = createApp ? test : test.skip;

maybe('openapi.yaml paths exactly match the live Express routes', () => {
  const app = createApp(createMemoryRepos());
  const implemented = routesFromApp(app);
  const documented = operationsFromSpec(specDoc());

  assert.ok(implemented.size > 0, 'no routes found on the app — introspection broke');
  assert.ok(documented.size > 0, 'no operations parsed from openapi.yaml');

  const undocumented = [...implemented].filter((op) => !documented.has(op)).sort();
  const orphaned = [...documented].filter((op) => !implemented.has(op)).sort();

  assert.deepEqual(
    undocumented,
    [],
    `routes served by Express but missing from openapi.yaml:\n  ${undocumented.join('\n  ')}`,
  );
  assert.deepEqual(
    orphaned,
    [],
    `operations in openapi.yaml with no matching Express route:\n  ${orphaned.join('\n  ')}`,
  );
});

maybe('openapi.yaml is structurally valid (parse, info, servers, responses)', () => {
  const doc = specDoc();

  assert.match(doc.openapi ?? '', /^3\./, '`openapi` must declare a 3.x version');
  assert.ok(doc.info?.title, 'info.title is missing');
  assert.ok(doc.info?.version, 'info.version is missing');
  assert.ok(
    Array.isArray(doc.servers) && doc.servers.length >= 2,
    'expected at least the dev + production servers',
  );
  assert.ok(doc.components?.securitySchemes?.bearerAuth, 'bearerAuth security scheme missing');
  assert.ok(doc.components?.schemas?.Error, 'shared Error schema missing');
  assert.ok(doc.components?.responses?.NotFound, 'shared NotFound response missing');

  const responses = doc.components?.responses ?? {};
  let ops = 0;
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      ops += 1;
      assert.ok(op.operationId, `${method.toUpperCase()} ${path}: missing operationId`);
      assert.ok(
        op.responses && Object.keys(op.responses).length > 0,
        `${method.toUpperCase()} ${path}: no responses declared`,
      );
      for (const [code, resp] of Object.entries(op.responses)) {
        const resolved = resp?.$ref ? resolveResponse(responses, resp.$ref) : resp;
        assert.ok(
          resolved?.description,
          `${method.toUpperCase()} ${path} [${code}]: response must have a description`,
        );
        if (resp?.$ref && !resolved) {
          assert.fail(`${method.toUpperCase()} ${path} [${code}]: unresolvable $ref ${resp.$ref}`);
        }
      }
    }
  }
  assert.ok(ops >= 30, `expected a substantial path surface, parsed only ${ops} operations`);
});

maybe('public endpoints are exactly the documented security: [] set', () => {
  const doc = specDoc();

  // Fail-closed allowlist: the three routes registered WITHOUT `requireOrg`
  // (routes.js / app.js). Any new public route is a security decision — the
  // test forces an explicit, reviewed entry here instead of a silent change.
  const PUBLIC = new Set([
    'GET /api/health',
    'GET /api/github/callback',
    'POST /api/billing/webhook',
  ]);

  const publicInSpec = new Set();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const effective = Array.isArray(op.security) ? op.security : doc.security;
      if (effective.length === 0) publicInSpec.add(`${method.toUpperCase()} ${path}`);
    }
  }

  assert.deepEqual(
    [...publicInSpec].sort(),
    [...PUBLIC].sort(),
    'the `security: []` set in openapi.yaml must match the app\'s public routes exactly. ' +
      'If you intentionally added a public endpoint, add it to the PUBLIC allowlist here ' +
      'and make sure it was reviewed (it bypasses the requireOrg choke point).',
  );
});
