/**
 * githubClient.js — the GitHub REST API client used by the publisher.
 *
 * Pure adapter over the GitHub REST API (global fetch), so the domain and
 * service layers stay free of HTTP plumbing and tests can inject a stub
 * `fetch`. Every method returns parsed JSON or throws a typed GitHubError.
 *
 * Push strategy — the git data API (blobs → tree → commit → ref) is used
 * instead of the contents API so a whole project scaffolds in FOUR requests
 * regardless of file count (blobs are created in parallel). That is what
 * keeps a publish inside the <5 second SLA even for a 20-file project.
 *
 * Auth-failure contract: HTTP 401 and 403 map to GitHubError with
 * `code = 'GITHUB_AUTH_REQUIRED'` so the service layer can translate it into
 * an inline re-authentication prompt WITHOUT losing the publish request's
 * state (repo name, files, spec).
 */

/** Typed error carrying the HTTP status and a stable machine code. */
export class GitHubError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const API_BASE = 'https://api.github.com';
const USER_AGENT = 'ai-workflow-builder-publisher';
/** Per-request ceiling — keeps a publish inside the <5s SLA. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @param {object} [opts]
 * @param {string} [opts.token] GitHub OAuth token (repo scope).
 * @param {typeof fetch} [opts.fetchImpl] Injectable fetch (tests).
 * @param {string} [opts.baseUrl] API base (tests).
 * @param {number} [opts.timeoutMs]
 */
export function createGithubClient({ token, fetchImpl = fetch, baseUrl = API_BASE, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const request = async (method, path, { body, headers = {}, expect = 200 } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': USER_AGENT,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new GitHubError(0, 'GITHUB_TIMEOUT', `GitHub API request timed out after ${timeoutMs}ms: ${method} ${path}`);
      }
      throw new GitHubError(0, 'GITHUB_NETWORK', `GitHub API request failed: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (res.status === 401 || res.status === 403) {
      throw new GitHubError(
        res.status,
        'GITHUB_AUTH_REQUIRED',
        `GitHub rejected the request (HTTP ${res.status})${json?.message ? `: ${json.message}` : ''}. Re-authenticate to continue.`,
        { action: 'reauth', status: res.status, reason: json?.message },
      );
    }
    if (res.status !== expect && !(expect === 200 && res.status === 201)) {
      const message = json?.message ?? `HTTP ${res.status}`;
      throw new GitHubError(res.status, 'GITHUB_API', `GitHub API error (${method} ${path}): ${message}`);
    }
    return json;
  };

  return {
    /** GET /user — the connected account (login, id, avatar). */
    async getUser() {
      return request('GET', '/user');
    },

    /**
     * POST /user/repos — create a new repository.
     * @returns {{ owner: string, name: string, full_name: string, html_url: string, private: boolean }}
     */
    async createRepo({ name, description = '', private: isPrivate = true, owner = null } = {}) {
      const body = { name, description, private: isPrivate, auto_init: false };
      if (owner) body.owner = owner;
      const repo = await request('POST', '/user/repos', { body, expect: 201 });
      return {
        owner: repo.owner?.login ?? owner ?? 'unknown',
        name: repo.name,
        full_name: repo.full_name ?? `${repo.owner?.login ?? owner}/${repo.name}`,
        html_url: repo.html_url,
        private: Boolean(repo.private),
      };
    },

    /**
     * Push a full file set to a repo in one commit — the <5s scaffold path.
     * Uses the git data API: parallel blob creation → tree → commit → ref.
     * Creates the branch if it does not exist (falls back to the default
     * branch when the repo was auto-initialized by GitHub).
     *
     * @param {{ owner: string, repo: string, files: Record<string,string>,
     *           message?: string, branch?: string }} args
     * @returns {{ sha: string, html_url: string, branch: string }}
     */
    async pushFiles({ owner, repo, files, message = 'Scaffold project from workflow-builders.com', branch = 'main' }) {
      const entries = Object.entries(files ?? {});
      if (entries.length === 0) throw new GitHubError(0, 'EMPTY_FILES', 'Nothing to push: file set is empty.');

      // 1. Create one blob per file, in parallel.
      const blobResults = await Promise.all(
        entries.map(async ([path, content]) => {
          const blob = await request('POST', `/repos/${owner}/${repo}/git/blobs`, {
            body: { content: String(content), encoding: 'utf-8' },
            expect: 201,
          });
          return { path, sha: blob.sha, mode: '100644', type: 'blob' };
        }),
      );

      // 2. Single tree referencing every blob.
      const tree = await request('POST', `/repos/${owner}/${repo}/git/trees`, {
        body: { tree: blobResults },
        expect: 201,
      });

      // 3. Commit on top of the branch tip (or the repo default branch).
      let baseSha = null;
      try {
        const ref = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
        baseSha = ref.object?.sha ?? null;
      } catch (err) {
        if (!(err instanceof GitHubError && err.status === 404)) throw err;
        baseSha = null; // branch does not exist yet → first commit
      }

      const commit = await request('POST', `/repos/${owner}/${repo}/git/commits`, {
        body: {
          message,
          tree: tree.sha,
          ...(baseSha ? { parents: [baseSha] } : {}),
        },
        expect: 201,
      });

      // 4. Point the branch at the commit (create or fast-forward).
      if (baseSha) {
        await request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
          body: { sha: commit.sha, force: false },
        });
      } else {
        await request('POST', `/repos/${owner}/${repo}/git/refs`, {
          body: { ref: `refs/heads/${branch}`, sha: commit.sha },
          expect: 201,
        });
      }

      return { sha: commit.sha, html_url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`, branch };
    },

    /**
     * Repository scraper — list the connected account's repos.
     * GET /user/repos?per_page=100&sort=updated (repo scope required).
     * @returns {Array<{ name, full_name, html_url, private, description, default_branch, updated_at }>}
     */
    async listRepos({ perPage = 100 } = {}) {
      const repos = await request('GET', `/user/repos?per_page=${perPage}&sort=updated`);
      return (repos ?? []).map((r) => ({
        name: r.name,
        full_name: r.full_name,
        html_url: r.html_url,
        private: Boolean(r.private),
        description: r.description,
        default_branch: r.default_branch ?? 'main',
        updated_at: r.updated_at,
      }));
    },

    /**
     * Repository scraper — read the file tree of one repo path.
     * GET /repos/{owner}/{repo}/contents/{path} — returns a flat listing of
     * files (contents API) or a directory listing. Never executes anything.
     */
    async getContents({ owner, repo, path = '' }) {
      const safe = path ? path.replace(/^\/+/, '') : '';
      const suffix = safe ? `/${safe.split('/').map(encodeURIComponent).join('/')}` : '';
      return request('GET', `/repos/${owner}/${repo}/contents${suffix}`);
    },

    /** Check the repo exists and the token can see it (pre-publish probe). */
    async getRepo({ owner, repo }) {
      return request('GET', `/repos/${owner}/${repo}`);
    },
  };
}
