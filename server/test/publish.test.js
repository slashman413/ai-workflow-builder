/**
 * publish.test.js — the GitHub publishing use case (Increment 4).
 *
 * Everything here runs against a stub GitHub client / stub fetch — no
 * network, no credentials. Covers:
 *   - the git-data push path (blobs → tree → commit → ref) and its <5s
 *     request graph;
 *   - the full publish pipeline: pre-flight → codegen → spec.yaml scaffold →
 *     create repo → push → publication ledger;
 *   - the graceful 401/403 path: GITHUB_AUTH_REQUIRED surfaces as a 401
 *     AppError with { action: 'reauth' } — and the publish request state is
 *     preserved (nothing was created, nothing lost);
 *   - the OAuth state store (single-use nonce, expiry) and the code exchange.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { ProjectService } from '../src/application/projectService.js';
import { PublishService } from '../src/application/publishService.js';
import { createOAuthStateStore, buildAuthorizeUrl, exchangeCode, OAuthError } from '../src/adapters/github/oauth.js';
import { createGithubClient } from '../src/domain/publish/githubClient.js';
import { generateKey, seal } from '../src/domain/vault/crypto.js';
import { AppError } from '../src/application/errors.js';

const KEK = generateKey();

/** A stub GitHub API server: records every request, returns canned payloads. */
function stubGitHubApi({ user = { login: 'octocat', id: 1 }, repos = [], failWith = null } = {}) {
  const calls = [];
  const routes = {
    'GET /user': () => user,
    'POST /user/repos': (body) => ({
      name: body.name,
      owner: { login: 'octocat' },
      full_name: `octocat/${body.name}`,
      html_url: `https://github.com/octocat/${body.name}`,
      private: Boolean(body.private),
    }),
    'POST /repos/:o/:r/git/blobs': () => ({ sha: 'blob-sha-' + calls.length }),
    'POST /repos/:o/:r/git/trees': () => ({ sha: 'tree-sha-1' }),
    'POST /repos/:o/:r/git/commits': () => ({ sha: 'commit-sha-1' }),
    'GET /repos/:o/:r/git/ref/heads/main': () => ({ object: { sha: 'base-sha-1' } }),
    'PATCH /repos/:o/:r/git/refs/heads/main': () => ({ ok: true }),
    'POST /repos/:o/:r/git/refs': () => ({ ref: 'refs/heads/main', object: { sha: 'commit-sha-1' } }),
    'GET /user/repos': () => repos,
    'GET /repos/:o/:r/contents': () => [{ name: 'main.py', type: 'file' }],
  };
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const method = opts.method ?? 'GET';
    let body = null;
    try {
      body = opts.body ? JSON.parse(opts.body) : null;
    } catch {
      body = opts.body;
    }
    calls.push({ method, path, body });
    if (failWith && (failWith.method === method || !failWith.method) && path.includes(failWith.path ?? '')) {
      return jsonResponse(failWith.status, { message: failWith.message ?? 'nope' });
    }
    // Route matching: normalize concrete owner/repo to :o/:r tokens.
    const norm = (s) => s.replace(/\/repos\/[^/]+\/[^/]+\//, '/repos/:o/:r/');
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && norm(p) === norm(path);
    });
    if (!key) return jsonResponse(404, { message: `no stub for ${method} ${path}` });
    // Creation endpoints return 201 in the real API.
    const status = method === 'POST' ? 201 : 200;
    return jsonResponse(status, routes[key](body));
  };
  return { fetchImpl, calls };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
  };
}

/** Build a publish-ready service with a stub GitHub API. */
function makePublishHarness({ api, workflowNodes } = {}) {
  const repos = createMemoryRepos();
  const service = new ProjectService(repos);
  const project = service.createProject('org-1', 'build a weekly newsletter');
  service.answer('org-1', project.id, {
    'goal.outcome': 'a weekly digest',
    'inputs.source': 'my starred repos',
    'outputs.shape': 'markdown report',
    'success.measure': 'every repo listed once',
  });
  const workflow = service.scaffoldWorkflow('org-1', project.id, { force: true });
  if (workflowNodes) workflow.nodes = workflowNodes;
  service.saveWorkflow('org-1', project.id, workflow);

  const oauthState = createOAuthStateStore();
  const publish = new PublishService({
    service,
    catalogService: { getPersonas: () => [], listTools: () => [] },
    repos,
    oauthState,
    createClient: ({ token }) => createGithubClient({ token, fetchImpl: api.fetchImpl }),
    kek: KEK,
    env: { GITHUB_CLIENT_ID: 'client-id', GITHUB_CLIENT_SECRET: 'client-secret' },
  });
  return { publish, service, repos, project, oauthState };
}

test('the git-data push path uses blobs → tree → commit → ref (4 requests)', async () => {
  const api = stubGitHubApi();
  const client = createGithubClient({ token: 't', fetchImpl: api.fetchImpl });
  const result = await client.pushFiles({
    owner: 'octocat',
    repo: 'demo',
    files: { 'main.py': 'print(1)', 'README.md': '# demo' },
  });
  assert.equal(result.sha, 'commit-sha-1');
  const paths = api.calls.map((c) => `${c.method} ${c.path}`);
  assert.ok(paths.includes('POST /repos/octocat/demo/git/blobs'), JSON.stringify(paths));
  assert.ok(paths.includes('POST /repos/octocat/demo/git/trees'));
  assert.ok(paths.includes('POST /repos/octocat/demo/git/commits'));
  assert.ok(paths.includes('PATCH /repos/octocat/demo/git/refs/heads/main'));
  // Exactly 2 blobs (parallel) + tree + commit + ref = 5 calls for the push.
  assert.equal(api.calls.filter((c) => c.path.endsWith('/git/blobs')).length, 2);
});

test('pushFiles creates the branch when it does not exist (first commit)', async () => {
  const api = stubGitHubApi();
  // Make the branch GET 404 → the client falls back to creating the ref.
  const original = api.fetchImpl;
  api.fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/git/ref/heads/main') && (opts.method ?? 'GET') === 'GET') {
      return jsonResponse(404, { message: 'Not Found' });
    }
    return original(url, opts);
  };
  const client = createGithubClient({ token: 't', fetchImpl: api.fetchImpl });
  await client.pushFiles({ owner: 'octocat', repo: 'demo', files: { 'main.py': 'x' } });
  assert.ok(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/git/refs')));
});

test('401/403 from GitHub map to GITHUB_AUTH_REQUIRED with reauth action', async () => {
  const api = stubGitHubApi({ failWith: { status: 401, path: '/user/repos' } });
  const { publish } = makePublishHarness({ api });
  // Connect an org first (token sealed) so the failure is the TOKEN, not the missing connection.
  publish.githubConnections.upsert('org-1', { login: 'octocat', tokenSealed: seal(KEK, 'expired-token'), scopes: ['repo'] });

  await assert.rejects(
    () => publish.listRepos('org-1'),
    (e) => e instanceof AppError && e.status === 401 && e.code === 'GITHUB_AUTH_REQUIRED' && e.details?.action === 'reauth',
  );
});

test('publish requires a GitHub connection and refuses a bad repo name', async () => {
  const api = stubGitHubApi();
  const { publish, project } = makePublishHarness({ api });

  await assert.rejects(
    () => publish.publish('org-1', project.id, { repoName: 'good-name' }),
    (e) => e.code === 'GITHUB_NOT_CONNECTED' && e.status === 401,
  );

  publish.githubConnections.upsert('org-1', { login: 'octocat', tokenSealed: seal(KEK, 'token'), scopes: ['repo'] });
  await assert.rejects(
    () => publish.publish('org-1', project.id, { repoName: 'bad name!' }),
    (e) => e.code === 'INVALID_REPO_NAME' && e.status === 422,
  );
});

test('publish runs the full pipeline: pre-flight → codegen → spec.yaml → repo → ledger', async () => {
  const api = stubGitHubApi();
  const { publish, project, repos } = makePublishHarness({ api });
  publish.githubConnections.upsert('org-1', { login: 'octocat', tokenSealed: seal(KEK, 'token'), scopes: ['repo'] });

  const result = await publish.publish('org-1', project.id, { repoName: 'newsletter-bot', description: 'A weekly digest', private: true });
  assert.equal(result.repoUrl, 'https://github.com/octocat/newsletter-bot');
  assert.equal(result.branch, 'main');
  assert.ok(result.latencyMs < 5000, `publish must be <5s, got ${result.latencyMs}ms`);
  assert.ok(result.fileCount >= 6, `expected full scaffold, got ${result.fileCount} files`);
  assert.ok(result.files.includes('main.py'));
  assert.ok(result.files.includes('README.md'));
  assert.ok(result.files.includes('tests/test_workflow.py'));
  assert.ok(result.files.includes('spec.yaml'), 'spec.yaml must be scaffolded');
  assert.ok(result.files.includes('workflow.json'));
  assert.ok(result.preflight.valid);

  // Publication ledger recorded.
  const pubs = repos.publications.listByOrg('org-1');
  assert.equal(pubs.length, 1);
  assert.equal(pubs[0].repoName, 'newsletter-bot');
  assert.equal(pubs[0].repoUrl, result.repoUrl);
  assert.ok(pubs[0].workflowHash.length === 64, 'sha256 workflow hash');

  // The pushed blob payloads actually contain the scaffolded files.
  const blobs = api.calls.filter((c) => c.path.endsWith('/git/blobs'));
  const contents = blobs.map((c) => c.body.content).join('\n');
  assert.match(contents, /def main/);
  assert.match(contents, /x-workflow-builders/); // spec.yaml
});

test('publish refuses a workflow that fails pre-flight (422 with details)', async () => {
  const api = stubGitHubApi();
  const { publish, service, repos } = makePublishHarness({ api });
  publish.githubConnections.upsert('org-1', { login: 'octocat', tokenSealed: seal(KEK, 'token'), scopes: ['repo'] });

  // A cyclic workflow persisted directly (saveWorkflow would refuse it — the
  // point here is that publish REFUSES too, before anything touches GitHub).
  const p2 = service.createProject('org-1', 'cyclic project');
  const wf = { id: 'wf_x', name: 'x', nodes: [
    { id: 'a', type: 'input', name: 'A', config: { sources: ['f'] }, dependsOn: ['b'] },
    { id: 'b', type: 'agent', name: 'B', config: { objective: 'o' }, dependsOn: ['a'] },
    { id: 'c', type: 'output', name: 'C', config: { targets: ['out'] }, dependsOn: ['b'] },
  ] };
  repos.workflows.save('org-1', p2.id, wf);

  await assert.rejects(
    () => publish.publish('org-1', p2.id, { repoName: 'cyclic' }),
    (e) => e.code === 'PREFLIGHT_FAILED' && e.status === 422 && Array.isArray(e.details?.errors),
  );

  // Nothing was created on GitHub.
  assert.equal(api.calls.filter((c) => c.method === 'POST' && c.path === '/user/repos').length, 0);
  assert.equal(repos.publications.listByOrg('org-1').length, 0);
});

test('repository scraper: listRepos and getContents hit the right endpoints', async () => {
  const api = stubGitHubApi({ repos: [{ name: 'demo', full_name: 'octocat/demo', html_url: 'https://github.com/octocat/demo', private: true, description: null, default_branch: 'main', updated_at: '2026-01-01' }] });
  const { publish } = makePublishHarness({ api });
  publish.githubConnections.upsert('org-1', { login: 'octocat', tokenSealed: seal(KEK, 'token'), scopes: ['repo'] });

  const repos = await publish.listRepos('org-1');
  assert.equal(repos.length, 1);
  assert.equal(repos[0].full_name, 'octocat/demo');

  const contents = await publish.getContents('org-1', { owner: 'octocat', repo: 'demo', path: '' });
  assert.equal(contents[0].name, 'main.py');
});

test('OAuth: authUrl requests repo scope and binds a single-use state', () => {
  const api = stubGitHubApi();
  const { publish, oauthState } = makePublishHarness({ api });
  const { url, state } = publish.authUrl({ orgId: 'org-1', userId: 'user-1' });
  assert.match(url, /github\.com\/login\/oauth\/authorize/);
  assert.match(url, /scope=repo/);
  assert.match(url, /state=/);
  assert.ok(oauthState.has(state));

  // Single-use: consuming twice must fail the second time.
  const binding = oauthState.consume(state);
  assert.equal(binding.orgId, 'org-1');
  assert.equal(oauthState.consume(state), null);
});

test('OAuth: buildAuthorizeUrl and exchangeCode honor config and errors', async () => {
  const url = buildAuthorizeUrl({ clientId: 'c', redirectUri: 'http://localhost:3001/api/github/callback', state: 's', scope: 'repo' });
  assert.match(url, /client_id=c/);

  await assert.rejects(
    async () => buildAuthorizeUrl({ clientId: '', redirectUri: '', state: '' }),
    (e) => e instanceof OAuthError && e.code === 'OAUTH_NOT_CONFIGURED',
  );

  const okFetch = async () => jsonResponse(200, { access_token: 'gho_abc', scope: 'repo,user', token_type: 'bearer' });
  const token = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'code', redirectUri: 'u', fetchImpl: okFetch });
  assert.equal(token.access_token, 'gho_abc');

  const badFetch = async () => jsonResponse(400, { error: 'bad_verification_code' });
  await assert.rejects(
    () => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'bad', redirectUri: 'u', fetchImpl: badFetch }),
    (e) => e instanceof OAuthError && e.code === 'OAUTH_EXCHANGE_FAILED',
  );
});

test('completeOAuth seals the token, stores the connection, and rejects replayed state', async () => {
  const api = stubGitHubApi();
  const { publish, oauthState, repos } = makePublishHarness({ api });
  const state = oauthState.set('org-1', 'user-1');

  const tokenFetch = async () => jsonResponse(200, { access_token: 'gho_secret', scope: 'repo', token_type: 'bearer' });
  publish.env = { GITHUB_CLIENT_ID: 'c', GITHUB_CLIENT_SECRET: 's' };
  // Monkey-patch exchangeCode path by overriding the module-level fetch: the
  // service uses exchangeCode() internally which defaults to global fetch —
  // so instead call through a client stub: the getUser call hits our API.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = tokenFetch;
  try {
    const result = await publish.completeOAuth({ code: 'the-code', state, redirectUri: 'http://localhost:3001/api/github/callback' });
    assert.equal(result.ok, true);
    assert.equal(result.login, 'octocat');
    const conn = repos.githubConnections.get('org-1');
    assert.equal(conn.login, 'octocat');
    assert.deepEqual(conn.scopes, ['repo']);
    assert.notEqual(conn.tokenSealed, 'gho_secret', 'token must be sealed, never stored plaintext');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Replayed state → rejected.
  const state2 = oauthState.set('org-1', 'user-1');
  oauthState.consume(state2);
  await assert.rejects(
    () => publish.completeOAuth({ code: 'x', state: state2, redirectUri: 'u' }),
    (e) => e.code === 'OAUTH_STATE_INVALID',
  );
});

test('publish of an already-failing GitHub repo call surfaces GITHUB_ERROR without state loss', async () => {
  const api = stubGitHubApi({ failWith: { status: 422, path: '/user/repos' } });
  const { publish, project } = makePublishHarness({ api });
  publish.githubConnections.upsert('org-1', { login: 'octocat', tokenSealed: seal(KEK, 'token'), scopes: ['repo'] });

  await assert.rejects(
    () => publish.publish('org-1', project.id, { repoName: 'taken-name' }),
    (e) => e.code === 'GITHUB_ERROR',
  );
  // The connection is intact — the user can retry the SAME publish after fixing the name.
  assert.equal(publish.status('org-1').connected, true);
});
