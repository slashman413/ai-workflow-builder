/**
 * deployService.js — Increment 5 one-click deploy.
 *
 * A deploy turns the saved workflow into a deployable scaffold: platform
 * config (wrangler.toml for Cloudflare Workers, fly.toml for Fly.io, or a
 * Dockerfile) is generated from the project + workflow, a deterministic URL
 * is assigned, and the bundle is persisted in the deployments ledger.
 *
 *   - Team/trial gate: Free plan cannot deploy (same assertExecutionAllowed
 *     gate as running — deploys and runs are both paid surfaces).
 *   - dry-run: generates + returns the bundle WITHOUT writing files and marks
 *     the row status `dry_run` (the UI's "preview config" mode).
 *   - real deploy: writes the generated files under data/deployments/<id>/
 *     (the scaffold is the deliverable; the URL is the target host).
 *
 * Platform URL conventions (deterministic from the project slug):
 *   cloudflare → https://<slug>.workflow-builders.workers.dev
 *   fly        → https://<slug>.fly.dev
 *   docker     → https://<slug>.workflow-builders.app
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, assertOrg } from './errors.js';
import { DEPLOYMENT_STATUS, PLATFORMS } from '../execution/types.js';

/** Build the deployable slug from the project (stable across deploys). */
export function slugify(project, workflow, env = {}) {
  const name = workflow?.name || project?.prompt || 'workflow';
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workflow';
  const salt = (env.DEPLOY_SALT ?? project?.id ?? 'app').replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
  return `${base}-${salt}`;
}

/** Deterministic deployment URL per platform. */
export function deploymentUrl(platform, slug) {
  switch (platform) {
    case 'cloudflare':
      return `https://${slug}.workflow-builders.workers.dev`;
    case 'fly':
      return `https://${slug}.fly.dev`;
    case 'docker':
      return `https://${slug}.workflow-builders.app`;
    default:
      throw new AppError('INVALID_PLATFORM', `platform must be one of: ${PLATFORMS.join(', ')}.`, 400);
  }
}

/** Generate the platform config bundle (files: name -> contents). */
export function generateConfig(platform, { project, workflow, slug }) {
  const workflowId = workflow?.id ?? `wf_${project.id}`;
  const compatibility = new Date().toISOString().slice(0, 10);
  const nodes = workflow?.nodes?.length ?? 0;
  switch (platform) {
    case 'cloudflare':
      return {
        'wrangler.toml': `name = "${slug}"
compatibility_date = "${compatibility}"
main = "src/index.js"
workers_dev = true

[vars]
WORKFLOW_ID = "${workflowId}"
WORKFLOW_NODES = "${nodes}"
`,
      };
    case 'fly':
      return {
        'fly.toml': `app = "${slug}"
primary_region = "sin"

[build]
  image = "node:22"

[env]
  WORKFLOW_ID = "${workflowId}"
  WORKFLOW_NODES = "${nodes}"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = true
`,
      };
    case 'docker':
      return {
        Dockerfile: `FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV WORKFLOW_ID=${workflowId}
ENV WORKFLOW_NODES=${nodes}
EXPOSE 8080
CMD ["npm", "start"]
`,
      };
    default:
      throw new AppError('INVALID_PLATFORM', `platform must be one of: ${PLATFORMS.join(', ')}.`, 400);
  }
}

export class DeployService {
  /**
   * @param {object} deps
   * @param {import('./projectService.js').ProjectService} deps.service
   * @param {import('./entitlementService.js').EntitlementService} deps.entitlementService
   * @param {any} deps.deployments DeploymentRepository
   * @param {object} [opts]
   * @param {object} [opts.env] Environment (slug salt).
   * @param {string} [opts.baseDir] Base directory for written scaffolds.
   */
  constructor({ service, entitlementService, deployments }, opts = {}) {
    this.service = service;
    this.entitlementService = entitlementService;
    this.deployments = deployments;
    this.opts = opts;
  }

  /**
   * Generate (and optionally scaffold) a deployment.
   * @returns {object} the deployment row ({ id, platform, status, config,
   *   url, createdAt })
   */
  deploy(orgId, projectId, { platform = 'cloudflare', dryRun = false } = {}) {
    assertOrg(orgId);
    if (!PLATFORMS.includes(platform)) {
      throw new AppError('INVALID_PLATFORM', `platform must be one of: ${PLATFORMS.join(', ')}.`, 400);
    }
    const project = this.service.getProject(orgId, projectId); // tenant + existence
    const workflow = this.service.getWorkflow(orgId, projectId);
    if (!workflow) {
      throw new AppError('NO_WORKFLOW', 'This project has no saved workflow to deploy — scaffold or save one first.', 409);
    }
    // Deploys consume the same paid surface as runs (Free = preview only).
    this.entitlementService.assertExecutionAllowed(orgId);

    const slug = slugify(project, workflow, this.opts.env ?? {});
    const url = deploymentUrl(platform, slug);
    const config = generateConfig(platform, { project, workflow, slug });
    const status = dryRun ? DEPLOYMENT_STATUS.DRY_RUN : DEPLOYMENT_STATUS.DEPLOYED;

    if (!dryRun) {
      // Write the scaffold so the deploy is a real artifact on disk.
      const dir = join(this.opts.baseDir ?? `${process.cwd()}/data/deployments`, `dep-${Date.now()}`);
      try {
        mkdirSync(dir, { recursive: true });
        for (const [name, contents] of Object.entries(config)) {
          writeFileSync(join(dir, name), contents, 'utf8');
        }
      } catch (err) {
        const deployment = this.deployments.create({
          orgId,
          projectId,
          platform,
          status: DEPLOYMENT_STATUS.FAILED,
          config,
          url,
          errorMessage: `scaffold write failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return deployment;
      }
    }

    return this.deployments.create({ orgId, projectId, platform, status, config, url });
  }

  /** Deployment history for a project (newest first). */
  list(orgId, projectId) {
    assertOrg(orgId);
    return this.deployments.listByProject(orgId, projectId);
  }
}
