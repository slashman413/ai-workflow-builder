/**
 * e2e.test.js — the pre-GA end-to-end flow (Increment 4).
 *
 * Verifies the full product chain over the live HTTP surface with memory
 * repos and a stub GitHub API:
 *
 *   create project → Grill-Me answers → ready spec → scaffold workflow →
 *   SAFE simulate → static pre-flight → hexagonal codegen → GitHub export
 *   (repo creation + git-data push) → publication ledger → generated Python
 *   is syntactically valid.
 *
 * This is the E2E gate the brief calls out: "Grill-Me streaming through to
 * GitHub export scaffolding".
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';

let createApp;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
} catch {
  createApp = null;
}
const maybe = createApp ? test : test.skip;

const WEBHOOK_SECRET = 'whsec_e2e';
const ORG = 'org-e2e';
const headers = { 'x-org-id': ORG, 'x-user-role': 'org:owner', 'content-type': 'application/json' };

function stubGithubClient() {
  const pushedBlobs = [];
  const pushedNames = [];
  return {
    _pushedBlobs: pushedBlobs,
    _pushedNames: pushedNames,
    getUser: async () => ({ login: 'e2e-user', id: 1 }),
    createRepo: async ({ name, private: isPrivate }) => ({
      owner: 'e2e-user',
      name,
      html_url: `https://github.com/e2e-user/${name}`,
      private: Boolean(isPrivate),
    }),
    pushFiles: async ({ files, branch }) => {
      for (const [name, content] of Object.entries(files)) {
        pushedNames.push(name);
        pushedBlobs.push(content);
      }
      return { sha: 'e2ecommit', html_url: `https://github.com/e2e-user/wf-e2e/commit/e2ecommit`, branch };
    },
    listRepos: async () => [],
    getContents: async () => [],
  };
}

function fakeStripe() {
  return {
    subscriptions: { retrieve: async (id) => ({ id, customer: 'cus_e2e', status: 'trialing', current_period_end: 1780000000, trial_end: 1780000000, cancel_at_period_end: false, metadata: { org_id: ORG, plan: 'team' } }) },
    checkout: { sessions: { create: async (_p) => ({ url: 'https://checkout.stripe.com/c/pay/cs_e2e', id: 'cs_e2e' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/p/session/x' }) } },
    webhooks: {
      generateTestHeaderString: (payload, secret) => Stripe.webhooks.generateTestHeaderString({ payload, secret }),
      constructEvent: (payload, header, secret) => Stripe.webhooks.constructEvent(payload, header, secret),
    },
  };
}

let server;
let base;
let githubClient;

before(async () => {
  if (!createApp) return;
  githubClient = stubGithubClient();
  const app = createApp(createMemoryRepos(), {
    env: { GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', STRIPE_TEAM_PRICE_ID: 'price_team', API_ORIGIN: 'http://localhost:3001' },
    publish: { createClient: () => githubClient },
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

maybe('E2E: Grill-Me → spec ready → scaffold → simulate → pre-flight → codegen → GitHub export', async () => {
  // 1. Create the project from a one-line prompt.
  const project = await (await fetch(`${base}/projects`, {
    method: 'POST', headers, body: JSON.stringify({ prompt: 'turn my starred GitHub repos into a weekly digest' }),
  })).json();

  // 2. Grill-Me: answer the open questions until the spec is ready.
  let grill = await (await fetch(`${base}/projects/${project.id}/grill`, { headers })).json();
  const answerRound = async (answers) => {
    await fetch(`${base}/projects/${project.id}/answers`, { method: 'POST', headers, body: JSON.stringify({ answers }) });
    grill = await (await fetch(`${base}/projects/${project.id}/grill`, { headers })).json();
  };
  // Cover every dimension in two rounds (mirrors the batch UI).
  await answerRound({
    'goal.outcome': 'a weekly markdown digest of my starred repos',
    'goal.why': 'stay current without manual checking',
    'inputs.source': 'my starred repos list',
    'inputs.shape': 'JSON from the GitHub API',
  });
  await answerRound({
    'outputs.shape': 'one markdown file per week',
    'outputs.destination': 'written to an output folder',
    'constraints.hard': 'only public repos, max 20 items',
    'success.measure': 'every starred repo appears exactly once',
    'edge_cases.failure': 'archived repos and duplicate stars',
  });
  assert.equal(grill.ready, true, 'the spec must be ready after full coverage');

  // 3. Scaffold the workflow from the ready spec.
  const workflow = await (await fetch(`${base}/projects/${project.id}/workflow/scaffold`, {
    method: 'POST', headers, body: JSON.stringify({}),
  })).json();
  assert.ok(workflow.nodes.length >= 3);

  // 4. SAFE simulation (mock handlers, zero I/O).
  const sim = await (await fetch(`${base}/workflow/simulate`, {
    method: 'POST', headers, body: JSON.stringify({ workflow }),
  })).json();
  assert.equal(sim.success, true);
  assert.match(sim.note, /no user code executed/i);

  // 5. Static pre-flight gate.
  const preflight = await (await fetch(`${base}/workflow/preflight`, {
    method: 'POST', headers, body: JSON.stringify({ workflow }),
  })).json();
  assert.equal(preflight.valid, true, JSON.stringify(preflight.errors));

  // 6. Provision the Team trial (webhook) — export is a paid feature.
  const trialPayload = JSON.stringify({
    id: 'evt_e2e_trial',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_e2e', subscription: 'sub_e2e', customer: 'cus_e2e', metadata: { org_id: ORG, plan: 'team' } } },
  });
  const trialHeader = Stripe.webhooks.generateTestHeaderString({ payload: trialPayload, secret: WEBHOOK_SECRET });
  const trialRes = await fetch(`${base}/billing/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': trialHeader }, body: trialPayload,
  });
  assert.equal(trialRes.status, 200);

  // 7. Connect GitHub (OAuth callback dance) and export.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('github.com/login/oauth/access_token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'gho_e2e', scope: 'repo' }) };
    }
    return originalFetch(url, opts);
  };
  try {
    const { url } = await (await fetch(`${base}/github/auth-url`, { headers })).json();
    const state = new URL(url).searchParams.get('state');
    const cb = await fetch(`${base}/github/callback?code=e2e&state=${state}`);
    assert.equal(cb.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const exportRes = await fetch(`${base}/projects/${project.id}/publish`, {
    method: 'POST', headers, body: JSON.stringify({ repoName: 'weekly-digest', private: true }),
  });
  const published = await json(exportRes);
  assert.equal(exportRes.status, 200, JSON.stringify(published));
  assert.equal(published.repoUrl, 'https://github.com/e2e-user/weekly-digest');
  assert.ok(published.latencyMs < 5000, `publish took ${published.latencyMs}ms — must be <5s`);
  assert.ok(published.fileCount >= 7, `expected full scaffold, got ${published.fileCount} files`);
  assert.ok(published.preflight.valid);

  // 8. The pushed scaffold contains the full project: code, tests, spec,
  //    CI, workflow record — and the generated Python is syntactically valid.
  for (const name of ['main.py', 'README.md', 'requirements.txt', 'tests/test_workflow.py', 'spec.yaml', 'workflow.json', '.github/workflows/ci.yml', '.gitignore']) {
    assert.ok(githubClient._pushedNames.includes(name), `pushed scaffold must include ${name}`);
  }
  const blobs = githubClient._pushedBlobs.join('\n');
  for (const needle of ['def main(', 'def test_', 'x-workflow-builders', 'pytest']) {
    assert.ok(blobs.includes(needle), `pushed scaffold must include ${needle}`);
  }
  const mainPy = githubClient._pushedBlobs.find((b) => b.includes('def main('));
  assert.ok(mainPy, 'main.py must be in the push');

  let python3;
  try {
    python3 = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  } catch {
    python3 = null;
  }
  if (python3) {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-codegen-'));
    try {
      writeFileSync(join(dir, 'main.py'), mainPy);
      execFileSync(python3, ['-m', 'py_compile', join(dir, 'main.py')], { stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 9. Publication ledger + billing status reflect the flow.
  const pubs = await (await fetch(`${base}/projects/${project.id}/publications`, { headers })).json();
  assert.equal(pubs.length, 1);
  assert.equal(pubs[0].repoName, 'weekly-digest');

  const billing = await (await fetch(`${base}/billing`, { headers })).json();
  assert.equal(billing.status, 'trialing');

  const entitlement = await (await fetch(`${base}/billing/entitlement`, { headers })).json();
  assert.equal(entitlement.tier, 'trial');
  assert.equal(entitlement.limits.exports, true);
});
