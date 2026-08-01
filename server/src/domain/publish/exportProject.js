/**
 * exportProject.js — the pure domain of repository publishing.
 *
 * Turns a generated code bundle (the codegen output, { path → contents })
 * into a validated GitHub export bundle: a repo name that satisfies GitHub's
 * rules, a file tree of blobs, a commit message, and a description. This
 * module is dependency-free — the GitHub REST calls happen in the adapter
 * (adapters/github/githubPublisher.js); here we only decide WHAT ships.
 *
 * The publisher refuses to export a workflow that does not pass the pre-flight
 * check (domain/workflow/preflight.js) — a broken DAG (cycle, dangling
 * dependency) is a blocking error, not something to push to a customer's
 * repository.
 */

import { preFlightCheck } from '../workflow/preflight.js';

/** GitHub repository name rules (https://docs.github.com/en/repositories/creating-and-managing-repositories). */
export const REPO_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
export const REPO_NAME_MAX = 100;

/**
 * @typedef {Object} ExportBundle
 * @property {string} repoName        Validated repository name.
 * @property {string} defaultBranch   Branch the commit lands on ('main').
 * @property {boolean} privateRepo    Visibility.
 * @property {string} commitMessage   Message for the root commit.
 * @property {string} description     GitHub repository description.
 * @property {{ path: string, content: string }[]} tree  Flat file tree in
 *   blob order (paths use forward slashes, relative to the repo root).
 */

/**
 * Validate a proposed GitHub repository name.
 *
 * @param {string} name
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateRepoName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'A repository name is required.' };
  }
  const trimmed = name.trim();
  if (trimmed.length > REPO_NAME_MAX) {
    return { ok: false, error: `Repository name must be at most ${REPO_NAME_MAX} characters.` };
  }
  if (!REPO_NAME_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error: 'Repository name may only contain letters, digits, hyphens, underscores and dots.',
    };
  }
  if (trimmed === '.' || trimmed === '..' || trimmed.endsWith('.git')) {
    return { ok: false, error: 'Repository name must not be "." , "..", or end in ".git".' };
  }
  return { ok: true, name: trimmed };
}

/**
 * Build the validated export bundle for one workflow export.
 *
 * @param {object} opts
 * @param {Record<string, string>} opts.files    Codegen output (path → contents).
 * @param {string} opts.repoName                 Desired repository name.
 * @param {object} [opts.workflow]               The source workflow (pre-flighted).
 * @param {string} [opts.defaultBranch]          Default branch ('main').
 * @param {boolean} [opts.private]               Repo visibility (default true).
 * @param {{ knownAgentIds?: Set<string>, knownLensIds?: Set<string> }} [opts.catalog]
 *   Catalog ids for the pre-flight binding checks (optional — passed through
 *   from the service, which knows the installed catalog).
 * @returns {{ ok: true, bundle: ExportBundle } | { ok: false, error: string, details?: object[] }}
 */
export function buildExportBundle({
  files,
  repoName,
  workflow = null,
  defaultBranch = 'main',
  private: privateRepo = true,
  catalog = {},
}) {
  const nameCheck = validateRepoName(repoName);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
    return { ok: false, error: 'There is no generated code to export — build the workflow first.' };
  }

  // Blocked export: a broken DAG must never reach a customer's repository.
  if (workflow) {
    const preflight = preFlightCheck(workflow, catalog);
    if (!preflight.ok) {
      return {
        ok: false,
        error: 'Pre-flight validation failed — the workflow is not exportable.',
        details: preflight.errors,
      };
    }
  }

  // Every codegen path is safe to commit; sanitize any path traversal just in
  // case a future generator emits a hostile path (defense in depth).
  const tree = Object.entries(files)
    .map(([path, content]) => {
      const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (clean.split('/').some((seg) => seg === '..' || seg === '.')) return null;
      return { path: clean, content: String(content) };
    })
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path));

  const goal = workflow?.name ?? 'untitled workflow';
  return {
    ok: true,
    bundle: {
      repoName: nameCheck.name,
      defaultBranch,
      privateRepo,
      commitMessage: `chore: export agent workflow "${String(goal).slice(0, 72)}" from workflow-builders.com`,
      description: 'Multi-agent workflow generated with workflow-builders.com (ai-workflow-builder).',
      tree,
    },
  };
}

/** Human summary of an export bundle (telemetry + task output). */
export function bundleSummary(bundle) {
  return `${bundle.tree.length} files → ${bundle.repoName} (${bundle.defaultBranch})`;
}
