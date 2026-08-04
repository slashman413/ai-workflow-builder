/**
 * executionService.js — Increment 5 use cases: run, control, inspect, and
 * re-run workflows through the production execution engine.
 *
 * Responsibilities:
 *   - start(): tenant + workflow existence checks, Team/trial entitlement
 *     gate (Free plan is preview-only), create the execution row, then kick
 *     the engine off DETACHED from the HTTP request — the run lives in the
 *     process, its state in SQLite, its progress on the SSE hub.
 *   - cancel / pause / resume(): route control commands to the live engine.
 *   - get() / list(): read models (execution + per-step logs).
 *   - retry(): re-run the latest (or a named) execution as a NEW execution
 *     linked via `retryOf`, preserving the audit chain.
 *   - subscribe()/unsubscribe(): the SSE fan-out surface for the dashboard.
 *
 * The engine instance map is keyed by execution id; a finished run is
 * removed so memory does not leak across many runs.
 */

import { AppError, assertOrg } from './errors.js';
import { ExecutionEngine } from '../execution/engine.js';
import { createLogger, createHub } from '../execution/logger.js';
import { EXECUTION_STATUS } from '../execution/types.js';

/** Terminal states — no control commands can touch a finished run. */
const TERMINAL = new Set([
  EXECUTION_STATUS.SUCCEEDED,
  EXECUTION_STATUS.FAILED,
  EXECUTION_STATUS.CANCELLED,
]);

export class ExecutionService {
  /**
   * @param {object} deps
   * @param {import('./projectService.js').ProjectService} deps.service
   * @param {import('./entitlementService.js').EntitlementService} deps.entitlementService
   * @param {import('./vaultService.js').VaultService} deps.vaultService
   * @param {import('./catalogService.js').CatalogService} deps.catalogService
   * @param {import('./telemetryService.js').TelemetryService} deps.telemetryService
   * @param {any} deps.executions ExecutionRepository
   * @param {any} deps.executionSteps ExecutionStepRepository
   * @param {object} [opts]
   * @param {object} [opts.env] Environment snapshot handed to handlers.
   * @param {object} [opts.options] Engine options (concurrency, handlers…).
   * @param {string} [opts.dataDir] Base directory for run deliverables.
   */
  constructor({ service, entitlementService, vaultService, catalogService, telemetryService, executions, executionSteps }, opts = {}) {
    this.service = service;
    this.entitlementService = entitlementService;
    this.vaultService = vaultService;
    this.catalogService = catalogService;
    this.telemetryService = telemetryService;
    this.executions = executions;
    this.executionSteps = executionSteps;
    this.opts = opts;
    this.hub = createHub();
    /** @type {Map<string, ExecutionEngine>} execId -> live engine */
    this.engines = new Map();
  }

  /** Assert the execution exists, belongs to the org, and matches the route's project. */
  #assertOwned(orgId, projectId, execId) {
    const execution = this.executions.get(orgId, execId);
    if (!execution || execution.projectId !== projectId) {
      throw new AppError('NOT_FOUND', `Execution ${execId} not found for project ${projectId}.`, 404);
    }
    return execution;
  }

  /** Create the execution row + engine, run detached, return the row. */
  #spawn({ orgId, projectId, workflow, retryOf = null, inputs = {} }) {
    const execution = this.executions.create({
      orgId,
      projectId,
      workflowId: workflow.id ?? `wf_${projectId}`,
      status: EXECUTION_STATUS.QUEUED,
      retryOf,
    });
    const logger = createLogger({ executions: this.executions, executionSteps: this.executionSteps, hub: this.hub });
    const engine = new ExecutionEngine({
      workflow,
      execution,
      logger,
      injections: {
        orgId,
        inputs,
        vault: this.vaultService,
        catalog: this.catalogService,
        env: this.opts.env,
        dataDir: this.opts.dataDir ? `${this.opts.dataDir}/${execution.id}` : undefined,
      },
      options: this.opts.options,
    });
    this.engines.set(execution.id, engine);

    engine
      .run()
      .catch((err) => {
        // The engine normally finalizes its own failures; this is the
        // last-resort net for a fatal engine bug (never a fabricated success).
        const message = err instanceof Error ? err.message : String(err);
        try {
          logger.executionStatus(execution, {
            status: EXECUTION_STATUS.FAILED,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - (engine.startedAtMs || Date.now()),
            errorMessage: `engine error: ${message}`,
          });
        } catch {
          /* the store may itself be gone — nothing left to persist */
        }
      })
      .finally(() => this.engines.delete(execution.id));

    return execution;
  }

  /**
   * Start a workflow run. Free plan → HTTP 402 before any state is created.
   */
  start(orgId, projectId, { inputs = {} } = {}) {
    assertOrg(orgId);
    this.service.getProject(orgId, projectId); // tenant + existence
    const workflow = this.service.getWorkflow(orgId, projectId);
    if (!workflow) {
      throw new AppError('NO_WORKFLOW', 'This project has no saved workflow — scaffold or save one before running.', 409);
    }
    const entitlement = this.entitlementService.assertExecutionAllowed(orgId);
    this.telemetryService?.capture(orgId, 'execution_started', {
      tier: entitlement.tier,
      mode: 'live',
      outcome: 'ok',
    });
    return this.#spawn({ orgId, projectId, workflow, inputs });
  }

  /** Abort a running execution; queued steps are marked cancelled. */
  cancel(orgId, projectId, execId) {
    const execution = this.#assertOwned(orgId, projectId, execId);
    if (TERMINAL.has(execution.status)) {
      throw new AppError('EXECUTION_FINISHED', `Execution ${execId} already finished (${execution.status}).`, 409);
    }
    const engine = this.engines.get(execId);
    if (engine) {
      engine.cancel();
    } else {
      // No live engine (e.g. post-restart): flip the row directly.
      this.executions.update(orgId, execId, {
        status: EXECUTION_STATUS.CANCELLED,
        finishedAt: new Date().toISOString(),
      });
    }
    return this.executions.get(orgId, execId);
  }

  /** Pause dispatching new steps (in-flight steps finish naturally). */
  pause(orgId, projectId, execId) {
    const execution = this.#assertOwned(orgId, projectId, execId);
    if (execution.status !== EXECUTION_STATUS.RUNNING) {
      throw new AppError('EXECUTION_NOT_RUNNING', `Execution ${execId} is not running (${execution.status}).`, 409);
    }
    this.engines.get(execId)?.pause();
    return this.executions.get(orgId, execId);
  }

  /** Resume a paused execution. */
  resume(orgId, projectId, execId) {
    const execution = this.#assertOwned(orgId, projectId, execId);
    if (execution.status !== EXECUTION_STATUS.PAUSED) {
      throw new AppError('EXECUTION_NOT_PAUSED', `Execution ${execId} is not paused (${execution.status}).`, 409);
    }
    this.engines.get(execId)?.resume();
    return this.executions.get(orgId, execId);
  }

  /** Full read model: execution row + ordered per-step logs. */
  get(orgId, projectId, execId) {
    const execution = this.#assertOwned(orgId, projectId, execId);
    const steps = this.executionSteps.listByExecution(orgId, execId);
    return { ...execution, steps };
  }

  /** Execution history for a project (newest first). */
  list(orgId, projectId) {
    assertOrg(orgId);
    return this.executions.listByProject(orgId, projectId);
  }

  /**
   * Re-run a previous execution (default: the project's latest). Creates a
   * NEW execution row linked via retryOf — history is append-only.
   */
  retry(orgId, projectId, { execId = null } = {}) {
    assertOrg(orgId);
    this.service.getProject(orgId, projectId);
    const source = execId
      ? this.#assertOwned(orgId, projectId, execId)
      : this.executions.latestForProject(orgId, projectId);
    if (!source) {
      throw new AppError('NOT_FOUND', `No execution to retry for project ${projectId}.`, 404);
    }
    if (!TERMINAL.has(source.status)) {
      throw new AppError('EXECUTION_RUNNING', `Execution ${source.id} is still ${source.status} — wait for it to finish before retrying.`, 409);
    }
    const workflow = this.service.getWorkflow(orgId, projectId);
    if (!workflow) {
      throw new AppError('NO_WORKFLOW', 'This project has no saved workflow to retry.', 409);
    }
    const entitlement = this.entitlementService.assertExecutionAllowed(orgId);
    this.telemetryService?.capture(orgId, 'execution_retried', {
      tier: entitlement.tier,
      mode: 'live',
      outcome: 'ok',
    });
    return this.#spawn({ orgId, projectId, workflow, retryOf: source.id });
  }

  /** SSE fan-out: register a stream writer for one execution. */
  subscribe(execId, cb) {
    return this.hub.subscribe(execId, cb);
  }

  unsubscribe(execId, cb) {
    this.hub.unsubscribe(execId, cb);
  }
}
