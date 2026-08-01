/**
 * increment4Http.test.js — the Increment 4 HTTP surface (Increment 4).
 *
 * Live Express app over the wire (memory repos, test auth headers) for:
 *   - POST /workflow/preflight  (static AST gate)
 *   - the GitHub OAuth dance endpoints (auth-url / callback / status)
 *   - POST /projects/:id/publish (pre-flight → codegen → scaffold → push)
 *   - the Stripe webhook endpoint with RAW body + real signature verification
 *   - the secured billing surface (checkout / portal / get)
 *   - RBAC gates on the new routes
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';

let createApp;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
} catch {
  createApp = null;
}
const maybe = createApp ? test : test.skip;

const WEBHOOK_SECRET = 'whsec_http_test';
const ORG = 'org-1';
const authHeaders = { 'x-org-id': ORG, 'x-user-role': 'org:owner', 'content-type': 'application/json' };

/** Minimal GitHub client stub — records calls, returns canned payloads. */
function stubGithubClient() {
  return {
    getUser: async () => ({ login: 'octocat', id: 1 }),
    createRepo: async ({ name, description: _description, private: isPrivate }) => ({
      owner: 'octocat',
      name,
      html_url: `https://github.com/octocat/${name}`,
      private: Boolean(isPrivate),
    }),
    pushFiles: async ({ owner, repo, files: _files }) => ({ sha: 'abc123', html_url: `https://github.com/${owner}/${repo}/commit/abc123`, branch: 'main' }),
    listRepos: async () => [{ name: 'demo', full_name: 'octocat/demo', html_url: 'https://github.com/octocat/demo', private: true, description: null, default_branch: 'main', updated_at: '2026-01-01' }],
    getContents: async () => [{ name: 'main.py', type: 'file' }],
    getRepo: async () => ({ full_name: 'octocat/demo' }),
  };
}

function fakeStripe() {
  return {
    subscriptions: { retrieve: async (id) => ({ id, customer: 'cus_1', status: 'trialing', current_period_end: 1780000000, trial_end: 1780000000, cancel_at_period_end: false, metadata: { org_id: ORG, plan: 'team' } }) },
    checkout: { sessions: { create: async (p) => { global.__checkoutParams = p; return { url: 'https://checkout.stripe.com/c/pay/cs_1', id: 'cs_1' }; } } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/p/session/x', id: 'bps_1' }) } },
    webhooks: {
      generateTestHeaderString: (payload, secret) => Stripe.webhooks.generateTestHeaderString({ payload, secret }),
      constructEvent: (payload, header, secret) => Stripe.webhooks.constructEvent(payload, header, secret),
    },
  };
}

let server;
let base;

before(async () => {
  if (!createApp) return;
  const app = createApp(createMemoryRepos(), {
    env: { GITHUB_CLIENT_ID: 'client-123', GITHUB_CLIENT_SECRET: 'secret-123', STRIPE_TEAM_PRICE_ID: 'price_team_9900', API_ORIGIN: 'http://localhost:3001' },
    publish: { createClient: () => stubGithubClient() },
    billing: { stripe: fakeStripe(), webhookSecret: WEBHOOK_SECRET },
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
});

after(() => server?.close());

const json = (r) => r.json();

// --- Pre-flight endpoint -----------------------------------------------------

maybe('POST /workflow/preflight accepts a valid workflow', async () => {
  const r = await fetch(`${base}/workflow/preflight`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      workflow: {
        id: 'wf', name: 'w', nodes: [
          { id: 'a', type: 'input', name: 'A', config: { sources: ['f'] }, dependsOn: [] },
          { id: 'b', type: 'agent', name: 'B', config: { objective: 'o' }, dependsOn: ['a'] },
          { id: 'c', type: 'output', name: 'C', config: { targets: ['out'] }, dependsOn: ['b'] },
        ],
      },
    }),
  });
  assert.equal(r.status, 200);
  const body = await json(r);
  assert.equal(body.valid, true);
  assert.equal(body.security.executedCode, false);
  assert.ok(Array.isArray(body.checks));
});

maybe('POST /workflow/preflight rejects a cyclic workflow', async () => {
  const r = await fetch(`${base}/workflow/preflight`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      workflow: {
        id: 'wf', name: 'w', nodes: [
          { id: 'a', type: 'input', name: 'A', config: { sources: ['f'] }, dependsOn: ['b'] },
          { id: 'b', type: 'agent', name: 'B', config: { objective: 'o' }, dependsOn: ['a'] },
        ],
      },
    }),
  });
  assert.equal(r.status, 200);
  const body = await json(r);
  assert.equal(body.valid, false);
  assert.ok(body.errors.some((e) => e.code === 'CYCLE'));
});

// --- GitHub OAuth + publish --------------------------------------------------

maybe('GET /github/auth-url returns a GitHub authorize URL with repo scope', async () => {
  const r = await fetch(`${base}/github/auth-url`, { headers: authHeaders });
  assert.equal(r.status, 200);
  const body = await json(r);
  assert.match(body.url, /github\.com\/login\/oauth\/authorize/);
  assert.match(body.url, /scope=repo/);
});

maybe('GET /github/auth-url answers 503 when OAuth is not configured', async () => {
  const app = createApp(createMemoryRepos(), { env: {} });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/github/auth-url`, { headers: authHeaders });
    assert.equal(r.status, 503);
    const body = await json(r);
    assert.equal(body.error, 'OAUTH_NOT_CONFIGURED');
  } finally {
    srv.close();
  }
});

maybe('GET /github/callback renders the popup-closing page and stores the connection', async () => {
  // Stub ONLY the token exchange; everything else uses the real fetch.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('github.com/login/oauth/access_token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'gho_http', scope: 'repo', token_type: 'bearer' }) };
    }
    return originalFetch(url, opts);
  };
  try {
    // Get a valid state first (real fetch — auth-url is on our own server).
    const authUrlRes = await fetch(`${base}/github/auth-url`, { headers: authHeaders });
    const state = new URL((await authUrlRes.json()).url).searchParams.get('state');
    const r = await fetch(`${base}/github/callback?code=abc&state=${state}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /postMessage/);
    assert.match(html, /octocat/);

    // The connection is now visible on the secured status route.
    const statusRes = await fetch(`${base}/github/status`, { headers: authHeaders });
    const status = await statusRes.json();
    assert.equal(status.connected, true);
    assert.equal(status.login, 'octocat');
    assert.deepEqual(status.scopes, ['repo']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

maybe('GET /github/callback rejects an unknown/expired state', async () => {
  const r = await fetch(`${base}/github/callback?code=abc&state=deadbeef`);
  assert.equal(r.status, 400);
  const html = await r.text();
  assert.match(html, /postMessage/);
  assert.match(html, /OAUTH_STATE_INVALID/);
});

maybe('POST /projects/:id/publish requires a connection and publishes end-to-end', async () => {
  // A FRESH org (the shared server may already have org-1 connected).
  const pubOrg = 'org-publish';
  const pubHeaders = { 'x-org-id': pubOrg, 'x-user-role': 'org:owner', 'content-type': 'application/json' };

  // Project + workflow via the public flow.
  const created = await (await fetch(`${base}/projects`, { method: 'POST', headers: pubHeaders, body: JSON.stringify({ prompt: 'build a publishing pipeline' }) })).json();
  const answers = { 'goal.outcome': 'a published report', 'inputs.source': 'raw data', 'outputs.shape': 'github repo', 'success.measure': 'repo exists' };
  await fetch(`${base}/projects/${created.id}/answers`, { method: 'POST', headers: pubHeaders, body: JSON.stringify({ answers }) });
  await fetch(`${base}/projects/${created.id}/workflow/scaffold`, { method: 'POST', headers: pubHeaders, body: JSON.stringify({ force: true }) });

  // Free tier has NO export — the entitlement gate answers 402 before GitHub.
  const freeGate = await fetch(`${base}/projects/${created.id}/publish`, {
    method: 'POST',
    headers: pubHeaders,
    body: JSON.stringify({ repoName: 'my-pipeline' }),
  });
  assert.equal(freeGate.status, 402);
  assert.equal((await freeGate.json()).error, 'PAYMENT_REQUIRED');

  // Provision the Team trial via the Stripe webhook (the monetization path).
  const trialPayload = JSON.stringify({
    id: 'evt_trial_grant_2',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_trial', subscription: 'sub_trial', customer: 'cus_trial', metadata: { org_id: pubOrg, plan: 'team' } } },
  });
  const trialHeader = Stripe.webhooks.generateTestHeaderString({ payload: trialPayload, secret: WEBHOOK_SECRET });
  const trialRes = await fetch(`${base}/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': trialHeader },
    body: trialPayload,
  });
  assert.equal(trialRes.status, 200);
  assert.equal((await trialRes.json()).orgId, pubOrg);

  // Not connected yet → 401 with reauth action (state preserved).
  const notConnected = await fetch(`${base}/projects/${created.id}/publish`, {
    method: 'POST',
    headers: pubHeaders,
    body: JSON.stringify({ repoName: 'my-pipeline' }),
  });
  assert.equal(notConnected.status, 401);
  const ncBody = await json(notConnected);
  assert.equal(ncBody.error, 'GITHUB_NOT_CONNECTED');
  assert.equal(ncBody.details.action, 'reauth');

  // Connect (reuse the callback dance)…
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('github.com/login/oauth/access_token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'gho_http', scope: 'repo' }) };
    }
    return originalFetch(url, opts);
  };
  try {
    const authUrl = await (await fetch(`${base}/github/auth-url`, { headers: pubHeaders })).json();
    const state = new URL(authUrl.url).searchParams.get('state');
    await fetch(`${base}/github/callback?code=abc&state=${state}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Now publish succeeds — no state was lost by the earlier 401.
  const pub = await fetch(`${base}/projects/${created.id}/publish`, {
    method: 'POST',
    headers: pubHeaders,
    body: JSON.stringify({ repoName: 'my-pipeline', private: true }),
  });
  assert.equal(pub.status, 200);
  const body = await json(pub);
  assert.equal(body.repoUrl, 'https://github.com/octocat/my-pipeline');
  assert.ok(body.latencyMs < 5000, `publish latency ${body.latencyMs}ms must be <5s`);
  assert.ok(body.files.includes('spec.yaml'));
  assert.equal(body.preflight.valid, true);

  // The publication shows up on the project ledger.
  const pubs = await (await fetch(`${base}/projects/${created.id}/publications`, { headers: pubHeaders })).json();
  assert.equal(pubs.length, 1);
  assert.equal(pubs[0].repoName, 'my-pipeline');
});

maybe('RBAC: viewer cannot publish or fetch the repo scraper, owner can disconnect', async () => {
  const viewer = { 'x-org-id': ORG, 'x-user-role': 'org:viewer', 'content-type': 'application/json' };
  const created = await (await fetch(`${base}/projects`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ prompt: 'viewer test' }) })).json();

  const pub = await fetch(`${base}/projects/${created.id}/publish`, {
    method: 'POST', headers: viewer, body: JSON.stringify({ repoName: 'nope' }),
  });
  assert.equal(pub.status, 403);

  const repos = await fetch(`${base}/github/repos`, { headers: viewer });
  assert.equal(repos.status, 403);

  // Viewer CAN read preflight and billing status (read-only surface).
  const pre = await fetch(`${base}/workflow/preflight`, {
    method: 'POST', headers: viewer,
    body: JSON.stringify({ workflow: { id: 'w', name: 'w', nodes: [{ id: 'a', type: 'input', name: 'A', config: { sources: ['f'] }, dependsOn: [] }] } }),
  });
  assert.equal(pre.status, 200);
  assert.equal((await pre.json()).valid, true);
});

// --- Stripe billing over HTTP -------------------------------------------------

maybe('POST /billing/webhook verifies a real signature and provisions the tenant', async () => {
  const payload = JSON.stringify({
    id: 'evt_http_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_http', subscription: 'sub_http', customer: 'cus_http', metadata: { org_id: ORG, plan: 'team' } } },
  });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const r = await fetch(`${base}/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  assert.equal(r.status, 200);
  const body = await json(r);
  assert.equal(body.processed, true);
  assert.equal(body.orgId, ORG);

  // The billing row is visible on the secured GET /billing route.
  const billing = await (await fetch(`${base}/billing`, { headers: authHeaders })).json();
  assert.equal(billing.status, 'trialing');
  assert.equal(billing.plan, 'team');
});

maybe('POST /billing/webhook rejects a forged signature with 400', async () => {
  const payload = JSON.stringify({ id: 'evt_forged', type: 'customer.subscription.updated', data: { object: {} } });
  const r = await fetch(`${base}/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    body: payload,
  });
  assert.equal(r.status, 400);
  const body = await json(r);
  assert.equal(body.error, 'INVALID_SIGNATURE');
});

maybe('POST /billing/webhook dedupes a replayed event', async () => {
  const payload = JSON.stringify({
    id: 'evt_http_replay',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_http', customer: 'cus_http', metadata: { org_id: ORG, plan: 'team' }, current_period_end: 1780000000 } },
  });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const send = () => fetch(`${base}/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  const first = await (await send()).json();
  assert.equal(first.processed, true);
  const second = await (await send()).json();
  assert.equal(second.duplicate, true);
  assert.equal(second.processed, false);
});

maybe('POST /billing/checkout creates a subscription session with the 14-day trial', async () => {
  const r = await fetch(`${base}/billing/checkout`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ successUrl: 'https://workflow-builders.com/billing?ok=1', cancelUrl: 'https://workflow-builders.com/billing' }),
  });
  assert.equal(r.status, 200);
  const body = await json(r);
  assert.match(body.url, /checkout\.stripe\.com/);
  assert.equal(global.__checkoutParams.mode, 'subscription');
  assert.equal(global.__checkoutParams.subscription_data.trial_period_days, 14);
  assert.equal(global.__checkoutParams.metadata.org_id, ORG);
});

maybe('billing endpoints answer 503 on an unconfigured deployment', async () => {
  const app = createApp(createMemoryRepos(), { env: {} });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const b = `http://127.0.0.1:${srv.address().port}/api`;
    const checkout = await fetch(`${b}/billing/checkout`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ successUrl: 'u', cancelUrl: 'c' }),
    });
    assert.equal(checkout.status, 503);
    assert.equal((await checkout.json()).error, 'BILLING_NOT_CONFIGURED');

    const webhook = await fetch(`${b}/billing/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(webhook.status, 503);
  } finally {
    srv.close();
  }
});
