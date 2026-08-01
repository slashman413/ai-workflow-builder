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
 * what the server actually serves, and parses just the `paths:` block of the
 * YAML — no new dependency, since the domain + server run dependency-light.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/** `/projects/:id` (Express) → `/projects/{id}` (OpenAPI). */
const normalize = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

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

/** Parse `METHOD /path` operations out of the `paths:` block of openapi.yaml. */
function operationsFromSpec() {
  const lines = readFileSync(OPENAPI_PATH, 'utf8').split('\n');
  const ops = new Set();
  let inPaths = false;
  let currentPath = null;
  for (const line of lines) {
    if (/^paths:/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^\S/.test(line)) break; // dedent out of paths:
    if (!inPaths) continue;
    const pathMatch = line.match(/^ {2}(\/\S+):\s*$/);
    if (pathMatch) { currentPath = pathMatch[1]; continue; }
    const methodMatch = line.match(/^ {4}(get|post|put|patch|delete|options|head):\s*$/);
    if (methodMatch && currentPath) ops.add(`${methodMatch[1].toUpperCase()} ${currentPath}`);
  }
  return ops;
}

const maybe = createApp ? test : test.skip;

maybe('openapi.yaml paths exactly match the live Express routes', () => {
  const app = createApp(createMemoryRepos());
  const implemented = routesFromApp(app);
  const documented = operationsFromSpec();

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
