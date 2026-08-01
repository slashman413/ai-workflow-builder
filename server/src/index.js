/**
 * index.js — the composition root. This is the ONLY place that decides which
 * concrete adapters to wire together. Chooses SQLite in production, falls back
 * to in-memory if `DB_FILE` is unset and `USE_MEMORY=1`.
 *
 * Security posture (Increment 2):
 *   - AUTH_MODE=clerk (default when CLERK_SECRET_KEY is set) verifies every
 *     request's session JWT with Clerk's backend SDK and binds `req.orgId`.
 *     Fail-fast at boot: no secret, no server.
 *   - VAULT_KEK must be a 32-byte base64 key in production (envelope
 *     encryption); without it the server refuses to boot rather than degrade
 *     to an ephemeral key.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './adapters/http/app.js';
import { createSqliteRepos } from './adapters/persistence/sqliteRepos.js';
import { createMemoryRepos } from './adapters/persistence/memoryRepos.js';
import { resolveAuthMode } from './adapters/http/auth.js';
import { loadKek } from './domain/vault/crypto.js';

const PORT = Number(process.env.PORT ?? 4000);
const DB_FILE = process.env.DB_FILE ?? './data/app.db';

function makeRepos() {
  if (process.env.USE_MEMORY === '1') {
    console.log('[db] using in-memory repositories (non-persistent)');
    return createMemoryRepos();
  }
  console.log(`[db] using SQLite at ${DB_FILE}`);
  mkdirSync(dirname(DB_FILE), { recursive: true });
  // Apply pending schema migrations at boot before serving traffic.
  return createSqliteRepos(DB_FILE, { log: (m) => console.log(m) });
}

function makeAuth() {
  // AUTH_MODE wins; otherwise presence of the Clerk secret opts in. In
  // production, resolveAuthMode fails closed: header-based identity is never
  // allowed (a deploy that forgets CLERK_SECRET_KEY refuses to boot instead
  // of silently trusting client-supplied x-org-id headers).
  const mode = resolveAuthMode();
  if (mode === 'clerk') {
    console.log('[auth] enforcing Clerk session verification (AUTH_MODE=clerk)');
    return { mode: 'clerk' }; // createAuth builds the client from CLERK_SECRET_KEY
  }
  console.log('[auth] test/dev mode: org identity from x-org-id headers (never in production)');
  return { mode: 'test' };
}

// Resolved once at boot so a missing/malformed KEK fails the deploy, not a
// request at 3am. In production loadKek() throws unless VAULT_KEK is set.
const kek = loadKek();
console.log('[vault] envelope encryption ready (AES-256-GCM, per-org DEK wrapped by environment KEK)');

const app = createApp(makeRepos(), { auth: makeAuth(), kek });
app.listen(PORT, () => {
  console.log(`ai-workflow-builder API listening on http://localhost:${PORT}`);
});
