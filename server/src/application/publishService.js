/**
 * publishService.js — the GitHub publishing use case (Increment 4).
 *
 * Orchestrates the full export pipeline for one project:
 *
 *   project + workflow  →  pre-flight AST validation  →  hexagonal codegen
 *   →  spec.yaml scaffold  →  GitHub repo creation  →  git-data push  →  ledger
 *
 * The pipeline is deliberately composed of the existing domain modules
 * (preflightWorkflow, generate, renderSpecYaml) so a publish is exactly as
 * safe as the safest link in the chain:
 *
 *   - PRE-FLIGHT IS MANDATORY. A workflow that fails static AST validation
 *     (cycles, dangling refs, schema mismatch, tool-boundary violations,
 *     executable-payload markers) is refused with HTTP 422 and the full
 *     error list — nothing is created on GitHub.
 *   - NO user-authored code executes on this server. The generated Python
 *     project is pushed to the USER's repository and runs on THEIR machine.
 *     This service only ever creates blobs/trees/commits via the GitHub API.
 *
 * Auth failures are mapped to a stable AppError (GITHUB_AUTH_REQUIRED, 401)
 * so the HTTP adapter can prompt an inline re-authentication. The publish
 * request itself (repo name, files, spec) is not discarded — the client
 * reconnects and re-submits; nothing was created on GitHub, so there is no
 * partial state to clean up.
 */

import { createHash } from 'node:crypto';
import { AppError, assertOrg } from './errors.js';
import { preflightWorkflow } from '../domain/workflow/preflight.js';
import { generate } from '../domain/codegen/generator.js';
import { renderSpecYaml } from '../domain/publish/specYaml.js';
import { GitHubError } from '../domain/publish/githubClient.js';
import { exchangeCode } from '../adapters/github/oauth.js';
import { open, seal as sealImpl } from '../domain/vault/crypto.js';

/** GitHub repo name rules: alphanumeric + . _ - ; cannot start with a dot. */
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class PublishService {
  /**
   * @param {object} deps
   * @param {import('./projectService.js').ProjectService} deps.service
   * @param {import('./catalogService.js').CatalogService} deps.catalogService
   * @param {{ githubConnections: any, publications: any }} deps.repos
   * @param {import('../adapters/github/oauth.js').createOAuthStateStore} deps.oauthState
   * @param {Function} deps.createClient  (token) => GitHub client (injectable
   *   so tests never touch the network).
   * @param {Buffer} deps.kek  Envelope key for sealing/unsealing tokens.
   * @param {object} [deps.env]
   */
  constructor({ service, catalogService, repos, oauthState, createClient, kek, env = process.env }) {
    this.service = service;
    this.catalogService = catalogService;
    this.githubConnections = repos.githubConnections;
    this.publications = repos.publications;
    this.oauthState = oauthState;
    this.createClient = createClient;
    this.kek = kek;
    this.env = env;
  }

  /* -------------------------------------------------------------------------
   * OAuth connection lifecycle
   * ---------------------------------------------------------------------- */

  /**
   * Start the OAuth dance. Creates the single-use state nonce bound to this
   * org+user and returns the GitHub authorize URL (scope=repo).
   */
  authUrl({ orgId, userId, redirectUri }) {
    assertOrg(orgId);
    const clientId = this.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      throw new AppError('OAUTH_NOT_CONFIGURED', 'GitHub OAuth is not configured on this deployment.', 503);
    }
    const state = this.oauthState.set(orgId, userId);
    const uri = redirectUri ?? this.defaultRedirectUri();
    const url = `https://github.com/login/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: uri,
      scope: 'repo',
      state,
      allow_signup: 'false',
    }).toString()}`;
    return { url, state };
  }

  /**
   * Complete the OAuth dance (called by the public callback route). The
   * state nonce is single-use: a replayed callback cannot re-bind. The token
   * is sealed with the envelope key before touching the database.
   */
  async completeOAuth({ code, state, redirectUri }) {
    const binding = this.oauthState.consume(state);
    if (!binding) {
      throw new AppError('OAUTH_STATE_INVALID', 'The OAuth state is unknown, expired, or already used. Start the connection again.', 400);
    }
    const { orgId, userId } = binding;
    const clientId = this.env.GITHUB_CLIENT_ID;
    const clientSecret = this.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new AppError('OAUTH_NOT_CONFIGURED', 'GitHub OAuth is not configured on this deployment.', 503);
    }
    const exchanged = await exchangeCode({
      clientId,
      clientSecret,
      code,
      redirectUri: redirectUri ?? this.defaultRedirectUri(),
    });
    const token = exchanged.access_token;
    const scopes = String(exchanged.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    // Identify the account and persist the sealed token.
    const client = this.createClient({ token });
    const user = await client.getUser().catch((err) => {
      if (err instanceof GitHubError) {
        throw new AppError('GITHUB_AUTH_REQUIRED', `Connected token was rejected by GitHub: ${err.message}`, 401, { action: 'reauth' });
      }
      throw err;
    });
    const connection = this.githubConnections.upsert(orgId, {
      login: user.login,
      tokenSealed: seal(this.kek, token),
      scopes,
    });
    return { ok: true, orgId, userId, login: connection.login, scopes };
  }

  /** Connection status for the org + recent publications (no token leakage). */
  status(orgId) {
    assertOrg(orgId);
    const connection = this.githubConnections.get(orgId);
    const publications = this.publications.listByOrg(orgId).slice(0, 10);
    return {
      connected: Boolean(connection),
      login: connection?.login ?? null,
      scopes: connection?.scopes ?? [],
      connectedAt: connection?.updatedAt ?? null,
      publications,
    };
  }

  /** Revoke the org's connection (token deleted; nothing else changes). */
  disconnect(orgId) {
    assertOrg(orgId);
    const removed = this.githubConnections.remove(orgId);
    if (!removed) throw new AppError('NOT_CONNECTED', 'This workspace has no GitHub connection to remove.', 404);
    return { disconnected: true, orgId };
  }

  /* -------------------------------------------------------------------------
   * Repository scraper (read-only; the "scrape before you publish" surface)
   * ---------------------------------------------------------------------- */

  /** List the connected account's repositories (repo scope). */
  async listRepos(orgId) {
    const client = this.requireClient(orgId);
    try {
      return await client.listRepos();
    } catch (err) {
      throw this.mapGitHubError(err);
    }
  }

  /** Read one path inside a repository (file or directory listing). */
  async getContents(orgId, { owner, repo, path = '' }) {
    const client = this.requireClient(orgId);
    try {
      return await client.getContents({ owner, repo, path });
    } catch (err) {
      throw this.mapGitHubError(err);
    }
  }

  /* -------------------------------------------------------------------------
   * Publish
   * ---------------------------------------------------------------------- */

  /**
   * Pre-flight validate → codegen → scaffold spec.yaml → create repo → push.
   *
   * @param {string} orgId
   * @param {string} projectId
   * @param {{ repoName?: string, description?: string, private?: boolean,
   *           branch?: string }} opts
   * @returns {Promise<{ repoUrl, sha, branch, latencyMs, fileCount, files,
   *                      summary, preflight }>}
   */
  async publish(orgId, projectId, { repoName, description = '', private: isPrivate = true, branch = 'main' } = {}) {
    assertOrg(orgId);
    const project = this.service.getProject(orgId, projectId);
    const workflow = this.service.getWorkflow(orgId, projectId);
    if (!workflow) {
      throw new AppError('NO_WORKFLOW', 'This project has no workflow yet. Scaffold and save one before publishing.', 409);
    }
    const name = String(repoName ?? '').trim();
    if (!REPO_NAME_RE.test(name)) {
      throw new AppError('INVALID_REPO_NAME', 'Repo name must be 1-100 chars: letters, digits, and . _ - (cannot start with a dot).', 422);
    }

    // 1. Mandatory pre-flight — static AST checks + catalog tool boundaries.
    const { personas, tools } = this.catalogContext();
    const preflight = preflightWorkflow(workflow, { personas, tools });
    if (!preflight.valid) {
      throw new AppError('PREFLIGHT_FAILED', `Workflow failed pre-flight validation: ${preflight.summary}`, 422, {
        errors: preflight.errors,
        warnings: preflight.warnings,
        checks: preflight.checks,
        security: preflight.security,
      });
    }

    // 2. Hexagonal codegen → full project file set + the spec.yaml scaffold.
    const generated = generate({ spec: project.spec ?? {}, workflow });
    const specYaml = renderSpecYaml(project.spec ?? {}, { projectId, generatedAt: new Date().toISOString() });
    const files = {
      ...generated.files,
      'spec.yaml': specYaml,
      'workflow.json': JSON.stringify(workflow, null, 2),
    };

    // 3. Create the repo and push — the <5s path (git data API, 4 requests).
    const client = this.requireClient(orgId);
    const t0 = performance.now();
    try {
      const repo = await client.createRepo({ name, description, private: isPrivate });
      const pushed = await client.pushFiles({ owner: repo.owner, repo: repo.name, files, message: `Scaffold "${project.prompt.slice(0, 72)}" from workflow-builders.com`, branch });
      const latencyMs = Math.round(performance.now() - t0);

      const publication = this.publications.record({
        orgId,
        projectId,
        repoOwner: repo.owner,
        repoName: repo.name,
        repoUrl: repo.html_url,
        private: isPrivate,
        fileCount: Object.keys(files).length,
        latencyMs,
        workflowHash: createHash('sha256').update(JSON.stringify(workflow)).digest('hex'),
      });

      return {
        repoUrl: repo.html_url,
        sha: pushed.sha,
        branch: pushed.branch,
        latencyMs,
        fileCount: Object.keys(files).length,
        files: Object.keys(files),
        summary: `Published ${Object.keys(files).length} files to ${repo.owner}/${repo.name} in ${latencyMs}ms`,
        publication,
        preflight: { valid: true, checks: preflight.checks, security: preflight.security },
      };
    } catch (err) {
      throw this.mapGitHubError(err);
    }
  }

  /** Publication ledger for one project. */
  listPublications(orgId, projectId) {
    assertOrg(orgId);
    return projectId ? this.publications.listByProject(orgId, projectId) : this.publications.listByOrg(orgId);
  }

  /* -------------------------------------------------------------------------
   * Helpers
   * ---------------------------------------------------------------------- */

  /** Resolve the catalog context for pre-flight (personas + tool allow-list). */
  catalogContext() {
    try {
      const grouped = this.catalogService.getPersonas();
      const personas = grouped.flatMap((d) => d.agents ?? []);
      const tools = this.catalogService.listTools();
      return { personas, tools };
    } catch {
      // Catalog not synced yet — pre-flight still runs structural + schema
      // checks; any tool call is then UNKNOWN (fail-closed on publish).
      return { personas: [], tools: [] };
    }
  }

  /** Load the org's GitHub client, or fail with an inline re-auth prompt. */
  requireClient(orgId) {
    const connection = this.githubConnections.get(orgId);
    if (!connection) {
      throw new AppError('GITHUB_NOT_CONNECTED', 'Connect a GitHub account (repo scope) before publishing.', 401, { action: 'reauth' });
    }
    let token;
    try {
      token = open(this.kek, connection.tokenSealed);
    } catch {
      throw new AppError('GITHUB_NOT_CONNECTED', 'The stored GitHub token could not be decrypted. Reconnect your GitHub account.', 401, { action: 'reauth' });
    }
    return this.createClient({ token });
  }

  /** Map a GitHub client error to an AppError without leaking internals. */
  mapGitHubError(err) {
    if (err instanceof AppError) return err;
    if (err instanceof GitHubError) {
      if (err.code === 'GITHUB_AUTH_REQUIRED') {
        return new AppError('GITHUB_AUTH_REQUIRED', err.message, 401, { action: 'reauth', status: err.status });
      }
      return new AppError('GITHUB_ERROR', `GitHub API error: ${err.message}`, err.status === 0 ? 502 : 502, {
        code: err.code,
        status: err.status,
      });
    }
    return err;
  }

  defaultRedirectUri() {
    return this.env.GITHUB_REDIRECT_URI ?? `${this.env.API_ORIGIN ?? 'http://localhost:3001'}/api/github/callback`;
  }
}

/** Seal a secret under the envelope key (mirrors the vault adapter). */
function seal(kek, plaintext) {
  return sealImpl(kek, plaintext);
}
