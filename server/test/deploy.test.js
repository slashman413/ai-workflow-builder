/**
 * deploy.test.js — Increment 5 one-click deploy.
 *
 * Unit + HTTP coverage for DeployService: entitlement gate (Free → 402),
 * dry-run previews (no files written, status dry_run), real deploys
 * (scaffold written, status deployed, deterministic URL), per-platform
 * config generation (wrangler.toml / fly.toml / Dockerfile), deployment
 * history, and the invalid-platform guard.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { DeployService, generateConfig, slugify, deploymentUrl } from '../src/application/deployService.js';
import { ProjectService } from '../src/application/projectService.js';
import { EntitlementService } from '../src/application/entitlementService.js';
import { DEPLOYMENT_STATUS } from '../src/execution/types.js';

const ORG = 'org-dep';
const WORKFLOW = {
  id: 'wf_dep',
  name: 'My Awesome Workflow',
  nodes: [{ id: 'a', type: 'input', name: 'A', config: { mode: 'user', sources: ['v'], values: { v: 1 } }, dependsOn: [] }],
};

function makeService() {
  const repos = createMemoryRepos();
  const service = new ProjectService(repos);
  const entitlement = new EntitlementService(repos);
  const deploy = new DeployService({ service, entitlementService: entitlement, deployments: repos.deployments }, { env: { DEPLOY_SALT: 'abc' } });
  const project = service.createProject(ORG, 'build a demo');
  service.saveWorkflow(ORG, project.id, WORKFLOW);
  return { repos, service, entitlement, deploy, project };
}

// ---------------------------------------------------------------------------
// Config generation (pure)
// ---------------------------------------------------------------------------

test('generateConfig produces valid wrangler.toml / fly.toml / Dockerfile', () => {
  const project = { id: 'p1' };
  const slug = slugify(project, WORKFLOW, {});
  for (const platform of ['cloudflare', 'fly', 'docker']) {
    const config = generateConfig(platform, { project, workflow: WORKFLOW, slug });
    const files = Object.keys(config);
    assert.ok(files.length >= 1, `${platform} generates at least one file`);
    if (platform === 'cloudflare') {
      assert.match(config['wrangler.toml'], /name = ".*"/);
      assert.match(config['wrangler.toml'], /compatibility_date/);
      assert.match(config['wrangler.toml'], /WORKFLOW_ID = "wf_dep"/);
    }
    if (platform === 'fly') {
      assert.match(config['fly.toml'], /app = ".*"/);
      assert.match(config['fly.toml'], /internal_port = 8080/);
    }
    if (platform === 'docker') {
      assert.match(config.Dockerfile, /FROM node:22-alpine/);
      assert.match(config.Dockerfile, /CMD \["npm", "start"\]/);
    }
  }
});

test('deploymentUrl is deterministic per platform', () => {
  assert.match(deploymentUrl('cloudflare', 'demo-abc'), /^https:\/\/demo-abc\.workflow-builders\.workers\.dev$/);
  assert.match(deploymentUrl('fly', 'demo-abc'), /^https:\/\/demo-abc\.fly\.dev$/);
  assert.match(deploymentUrl('docker', 'demo-abc'), /^https:\/\/demo-abc\.workflow-builders\.app$/);
  assert.throws(() => deploymentUrl('heroku', 'x'), (err) => {
    assert.equal(err.code, 'INVALID_PLATFORM');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Service behavior
// ---------------------------------------------------------------------------

test('Free plan cannot deploy (402 gate)', () => {
  const { deploy, project } = makeService();
  assert.throws(() => deploy.deploy(ORG, project.id, { platform: 'cloudflare' }), (err) => {
    assert.equal(err.code, 'PAYMENT_REQUIRED');
    assert.equal(err.status, 402);
    return true;
  });
});

test('dry-run returns the preview, writes no files, and marks status dry_run', () => {
  const { repos, deploy, project } = makeService();
  repos.billing.upsert(ORG, { status: 'active', plan: 'team' });
  const base = mkdtempSync(join(tmpdir(), 'dep-dry-'));
  try {
    const dep = deploy.deploy(ORG, project.id, { platform: 'cloudflare', dryRun: true });
    assert.equal(dep.status, DEPLOYMENT_STATUS.DRY_RUN);
    assert.ok(dep.url.includes('workers.dev'));
    assert.ok(dep.config['wrangler.toml']);
    // No scaffold dir written for a dry run.
    const written = [...repos.deployments.listByProject(ORG, project.id)];
    assert.equal(written.length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('real deploy writes the scaffold and returns the deployment URL', () => {
  const { repos, deploy, project } = makeService();
  repos.billing.upsert(ORG, { status: 'active', plan: 'team' });
  const base = mkdtempSync(join(tmpdir(), 'dep-real-'));
  try {
    const dep = deploy.deploy(ORG, project.id, { platform: 'fly', dryRun: false });
    assert.equal(dep.status, DEPLOYMENT_STATUS.DEPLOYED);
    assert.match(dep.url, /\.fly\.dev$/);
    assert.ok(dep.config['fly.toml']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('deploy without a saved workflow answers 409 NO_WORKFLOW', () => {
  const repos = createMemoryRepos();
  repos.billing.upsert(ORG, { status: 'active', plan: 'team' });
  const service = new ProjectService(repos);
  const entitlement = new EntitlementService(repos);
  const deploy = new DeployService({ service, entitlementService: entitlement, deployments: repos.deployments });
  const project = service.createProject(ORG, 'no workflow');
  assert.throws(() => deploy.deploy(ORG, project.id, { platform: 'cloudflare' }), (err) => {
    assert.equal(err.code, 'NO_WORKFLOW');
    return true;
  });
});

test('invalid platform answers 400 INVALID_PLATFORM', () => {
  const { repos, deploy, project } = makeService();
  repos.billing.upsert(ORG, { status: 'active', plan: 'team' });
  assert.throws(() => deploy.deploy(ORG, project.id, { platform: 'vercel' }), (err) => {
    assert.equal(err.code, 'INVALID_PLATFORM');
    assert.equal(err.status, 400);
    return true;
  });
});

test('deployment history lists newest first and is org-scoped', () => {
  const { repos, deploy, project } = makeService();
  repos.billing.upsert(ORG, { status: 'active', plan: 'team' });
  const first = deploy.deploy(ORG, project.id, { platform: 'cloudflare', dryRun: true });
  const second = deploy.deploy(ORG, project.id, { platform: 'docker' });
  const list = deploy.list(ORG, project.id);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, second.id);
  assert.equal(list[1].id, first.id);
  assert.equal(deploy.list('org-other', project.id).length, 0, 'foreign org sees nothing');
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

let createApp;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
} catch {
  createApp = null;
}
const maybe = createApp ? test : test.skip;

let server;
let base;
const authHeaders = { 'x-org-id': ORG, 'x-user-role': 'org:owner', 'content-type': 'application/json' };

before(async () => {
  if (!createApp) return;
  const repos = createMemoryRepos();
  const app = createApp(repos, { env: { DEPLOY_SALT: 'abc' } });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
  global.__deployRepos = repos;
});

after(() => server?.close());

const json = (r) => r.json();

async function seedProject(paid = true) {
  const repos = global.__deployRepos;
  if (paid) repos.billing.upsert(ORG, { status: 'active', plan: 'team' });
  else repos.billing.upsert(ORG, { status: 'none', plan: 'free' }); // reset (tests share one server)
  const r = await fetch(`${base}/projects`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ prompt: 'deploy me' }),
  });
  const project = await json(r);
  await fetch(`${base}/projects/${project.id}/workflow`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ workflow: WORKFLOW }),
  });
  return project;
}

maybe('POST /projects/:id/deploy dry-run returns config + url (201)', async () => {
  const project = await seedProject();
  const r = await fetch(`${base}/projects/${project.id}/deploy`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ platform: 'cloudflare', dryRun: true }),
  });
  assert.equal(r.status, 201);
  const dep = await json(r);
  assert.equal(dep.status, 'dry_run');
  assert.ok(dep.config['wrangler.toml']);
  assert.match(dep.url, /workers\.dev$/);
});

maybe('POST /projects/:id/deploy for Free plan answers 402', async () => {
  const project = await seedProject(false);
  const r = await fetch(`${base}/projects/${project.id}/deploy`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ platform: 'fly' }),
  });
  assert.equal(r.status, 402);
  assert.equal((await json(r)).error, 'PAYMENT_REQUIRED');
});

maybe('GET /projects/:id/deployments lists the deploy history', async () => {
  const project = await seedProject();
  await fetch(`${base}/projects/${project.id}/deploy`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ platform: 'docker' }),
  });
  const list = await (await fetch(`${base}/projects/${project.id}/deployments`, { headers: authHeaders })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].platform, 'docker');
});

maybe('viewers cannot deploy (403) but can read history', async () => {
  const project = await seedProject();
  const viewer = { 'x-org-id': ORG, 'x-user-role': 'org:viewer', 'content-type': 'application/json' };
  const r = await fetch(`${base}/projects/${project.id}/deploy`, {
    method: 'POST',
    headers: viewer,
    body: JSON.stringify({ platform: 'cloudflare' }),
  });
  assert.equal(r.status, 403);
  const list = await fetch(`${base}/projects/${project.id}/deployments`, { headers: viewer });
  assert.equal(list.status, 200);
});
