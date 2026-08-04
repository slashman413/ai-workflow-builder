/**
 * engine.js — the Increment 5 workflow runtime.
 *
 * Executes a validated workflow DAG with:
 *   - concurrency-limited scheduling (default 4 parallel steps),
 *   - per-step timeout + retry with backoff (scheduler.js),
 *   - conditional branching: a branch node's output gates which dependents
 *     run (output.next / output.decisions),
 *   - error recovery: per-node config.continueOnError or run-level
 *     continueOnError; otherwise an error-handler branch (config.handles /
 *     config.onError, Inc 1 semantics) gets a chance to recover the run,
 *   - pause / resume / cancel controls,
 *   - a full audit trail: every step transition is persisted + streamed
 *     through the logger.
 *
 * The engine is created per execution (control flags are per-run) and the
 * ExecutionService owns the instance map. `run()` is async and detached from
 * the HTTP request that started it; the service awaits it only to capture
 * fatal errors.
 *
 * Safety posture: only the BUILT-IN handlers (input/agent/tool/branch/
 * output) ever run. There is no user-code execution surface.
 */

import { validateWorkflow } from '../domain/workflow/validateWorkflow.js';
import { topoSort } from '../domain/workflow/topoSort.js';
import { handlesError } from '../domain/executor/handlers.js';
import { inputHandler } from './handler/input.js';
import { agentHandler } from './handler/agent.js';
import { toolHandler } from './handler/tool.js';
import { branchHandler } from './handler/branch.js';
import { outputHandler } from './handler/output.js';
import { executeNode } from './scheduler.js';
import { DEFAULTS, EXECUTION_STATUS, STEP_STATUS } from './types.js';

/** The default handler table (per-node overridable via options.handlers). */
export const DEFAULT_HANDLERS = Object.freeze({
  input: inputHandler,
  agent: agentHandler,
  tool: toolHandler,
  branch: branchHandler,
  output: outputHandler,
});

/**
 * @param {object} opts
 * @param {object} opts.workflow the workflow DAG to run
 * @param {object} opts.execution the execution row (orgId, id, projectId, …)
 * @param {object} opts.logger execution logger (createLogger)
 * @param {object} [opts.injections] runtime wiring: { vault, catalog, env,
 *   fetchFn, dataDir, inputs, orgId }
 * @param {object} [opts.options] engine options: { concurrency,
 *   continueOnError, handlers, defaults }
 */
export class ExecutionEngine {
  constructor({ workflow, execution, logger, injections = {}, options = {} }) {
    this.workflow = workflow;
    this.execution = execution;
    this.logger = logger;
    this.injections = injections;
    this.options = options;
    this.defaults = { ...DEFAULTS, ...(options.defaults ?? {}) };
    this.handlers = { ...DEFAULT_HANDLERS, ...(options.handlers ?? {}) };

    this.control = {
      paused: false,
      cancelled: false,
      abort: new AbortController(),
      resumeWaiters: [],
    };

    // Run state (the engine is single-run; created per execution).
    this.validationError = null;
    this.startedAtMs = 0;
    this.sortedNodes = [];
    this.context = null;
    this.completed = new Map(); // nodeId -> { status, output?, error?, step? }
    this.gated = new Set();
    this.running = new Set();
    this.runningIds = new Set();
  }

  pause() {
    this.control.paused = true;
    this.logger.executionStatus(this.execution, { status: EXECUTION_STATUS.PAUSED });
  }

  resume() {
    this.control.paused = false;
    for (const resolve of this.control.resumeWaiters.splice(0)) resolve();
    this.logger.executionStatus(this.execution, { status: EXECUTION_STATUS.RUNNING });
  }

  cancel() {
    this.control.cancelled = true;
    this.control.paused = false;
    this.control.abort.abort(new Error('execution cancelled'));
    for (const resolve of this.control.resumeWaiters.splice(0)) resolve();
  }

  /**
   * Run the DAG to completion (or cancellation/failure).
   * @returns {Promise<object>} the final execution row
   */
  async run() {
    const { workflow, execution, logger, injections } = this;
    if (!this.#prepare()) {
      return this.#finalize(EXECUTION_STATUS.FAILED, this.validationError);
    }

    this.startedAtMs = Date.now();
    logger.executionStatus(execution, {
      status: EXECUTION_STATUS.RUNNING,
      startedAt: new Date().toISOString(),
    });

    // Shared run context handlers read from.
    const outputs = {};
    const errors = {};
    const ran = new Set();
    this.context = {
      node: null, // set per dispatch
      orgId: execution.orgId,
      inputs: injections.inputs ?? {},
      env: { ...process.env, ...(injections.env ?? {}) },
      vault: injections.vault ?? null,
      catalog: injections.catalog ?? null,
      fetchFn: injections.fetchFn ?? fetch,
      dataDir: injections.dataDir ?? `${process.cwd()}/data/executions/${execution.id}`,
      outputs,
      errors,
      ran,
      get: (id) => outputs[id],
      getError: (id) => errors[id],
    };
    const { context } = this;

    const startStep = (node) => {
      const handler = this.handlers[node.type];
      this.runningIds.add(node.id);
      const inputSnapshot = {};
      for (const dep of node.dependsOn ?? []) inputSnapshot[dep] = outputs[dep];
      // The tracked promise includes the settle follow-up (gating / error
      // recovery), so the dispatch loop waits for recovery before racing.
      const promise = executeNode({
        node,
        handler,
        ctx: { ...context, node, inputSnapshot },
        logger,
        execution,
        signal: this.control.abort.signal,
        defaults: this.defaults,
      }).then((result) => {
        this.running.delete(promise);
        this.runningIds.delete(node.id);
        return this.#onStepSettled(node, result);
      });
      this.running.add(promise);
      return promise;
    };

    // ---- main dispatch loop ------------------------------------------------
    // Runs until every node is completed. In-flight steps finish naturally;
    // pause halts dispatching (and blocks the loop when idle); cancel aborts
    // in-flight steps and marks the rest cancelled.
    while (this.completed.size < this.sortedNodes.length) {
      if (this.control.cancelled) break;

      if (this.control.paused) {
        if (this.running.size === 0) {
          await new Promise((resolve) => this.control.resumeWaiters.push(resolve));
          continue; // re-check cancelled/paused after resume
        }
        await Promise.race([...this.running]);
        continue;
      }

      const capacity = this.defaults.CONCURRENCY - this.running.size;
      if (capacity > 0) {
        for (const node of this.#readyNodes().slice(0, capacity)) startStep(node);
      }

      if (this.running.size === 0) break; // exhausted (gated/blocked) or done
      await Promise.race([...this.running]);
    }

    // ---- finalize -----------------------------------------------------------
    if (this.control.cancelled) {
      for (const node of this.sortedNodes) {
        if (this.completed.has(node.id)) continue;
        this.completed.set(node.id, { status: STEP_STATUS.CANCELLED });
        logger.stepSkipped(execution, {
          nodeId: node.id,
          nodeType: node.type,
          status: STEP_STATUS.CANCELLED,
          errorMessage: 'execution cancelled',
        });
      }
      return this.#finalize(EXECUTION_STATUS.CANCELLED, null);
    }

    const failed = [...this.completed.values()].find((c) => c.status === STEP_STATUS.ERROR);
    if (failed) {
      return this.#finalize(EXECUTION_STATUS.FAILED, failed.error ?? 'workflow step failed');
    }
    return this.#finalize(EXECUTION_STATUS.SUCCEEDED, null);
  }

  /** Nodes ready to dispatch right now (deps done, not gated, not blocked). */
  #readyNodes() {
    const ready = [];
    for (const node of this.sortedNodes) {
      if (this.completed.has(node.id) || this.runningIds.has(node.id)) continue;
      if (this.gated.has(node.id)) {
        this.#skipNode(node, 'skipped by branch decision');
        continue;
      }
      if (!(node.dependsOn ?? []).every((d) => this.completed.has(d))) continue;
      const blocker = (node.dependsOn ?? []).find((d) => {
        const c = this.completed.get(d);
        return c && (c.status === STEP_STATUS.SKIPPED || c.status === STEP_STATUS.CANCELLED);
      });
      if (blocker) {
        this.#skipNode(node, `dependency "${blocker}" did not execute`);
        continue;
      }
      ready.push(node);
    }
    return ready.sort(
      (a, b) => this.sortedNodes.findIndex((n) => n.id === a.id) - this.sortedNodes.findIndex((n) => n.id === b.id),
    );
  }

  /** Mark a node skipped in state + ledger. */
  #skipNode(node, reason) {
    this.completed.set(node.id, { status: STEP_STATUS.SKIPPED, error: reason });
    this.logger.stepSkipped(this.execution, {
      nodeId: node.id,
      nodeType: node.type,
      status: STEP_STATUS.SKIPPED,
      errorMessage: reason,
    });
  }

  /**
   * React to one step settling: record the outcome, gate dependents after a
   * branch decision, and attempt error recovery before aborting.
   */
  async #onStepSettled(node, result) {
    const { context, logger, execution } = this;
    if (result.status === 'success') {
      context.outputs[node.id] = result.output;
      context.ran.add(node.id);
      this.completed.set(node.id, { status: STEP_STATUS.SUCCESS, output: result.output, step: result.step });
      if (node.type === 'branch' && result.output) {
        this.#applyBranchGates(node, result.output);
      }
      return;
    }

    if (result.status === 'cancelled') {
      this.completed.set(node.id, { status: STEP_STATUS.CANCELLED, error: result.error ?? 'cancelled', step: result.step });
      return;
    }

    // status === 'error'
    context.errors[node.id] = { message: result.error };
    this.completed.set(node.id, { status: STEP_STATUS.ERROR, error: result.error, step: result.step });
    if (this.control.cancelled) return;

    const nodeConfig = node.config ?? {};
    if (nodeConfig.continueOnError === true || this.options.continueOnError === true) {
      return; // run continues; dependents may read context.getError(id)
    }

    // Error-handler branch (Inc 1 semantics): a branch declaring
    // config.handles / config.onError for this node may recover the run.
    const recovered = await this.#tryErrorHandler(node.id);
    if (!recovered) {
      for (const n of this.sortedNodes) {
        if (this.completed.has(n.id) || this.running.has(n.id)) continue;
        this.#skipNode(n, `workflow aborted at "${node.id}": ${result.error}`);
      }
    }
  }

  /** Gate a branch node's dependents based on its decision output. */
  #applyBranchGates(node, output) {
    const dependents = this.sortedNodes
      .filter((n) => (n.dependsOn ?? []).includes(node.id))
      .map((n) => n.id);
    const decisions = output.decisions ?? null;
    if (decisions && typeof decisions === 'object' && Object.keys(decisions).length > 0) {
      for (const dep of dependents) {
        if (decisions[dep] === false) this.gated.add(dep);
      }
      return;
    }
    if (typeof output.next === 'string' && output.next) {
      for (const dep of dependents) {
        if (dep !== output.next) this.gated.add(dep);
      }
    }
  }

  /**
   * Run a branch that declares responsibility for the failed node.
   * @returns {Promise<boolean>} true when the failure was handled
   */
  async #tryErrorHandler(failedId) {
    const candidate = this.sortedNodes.find((branch) => {
      if (branch.type !== 'branch' || this.completed.has(branch.id) || this.gated.has(branch.id)) return false;
      if (!handlesError(branch, failedId)) return false;
      return (branch.dependsOn ?? []).every((d) => this.completed.has(d) || d === failedId);
    });
    if (!candidate) return false;

    const { context, logger, execution } = this;
    const inputSnapshot = {};
    for (const dep of candidate.dependsOn ?? []) inputSnapshot[dep] = context.outputs[dep];
    const ctx = { ...context, node: candidate, inputSnapshot, signal: this.control.abort.signal };
    const step = logger.stepStarted(execution, {
      nodeId: candidate.id,
      nodeType: candidate.type,
      inputData: inputSnapshot,
    });
    const started = Date.now();

    let output;
    try {
      output = await this.handlers.branch(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.completed.set(candidate.id, { status: STEP_STATUS.ERROR, error: message, step });
      logger.stepFinished(execution, step, {
        status: STEP_STATUS.ERROR,
        errorMessage: message,
        durationMs: Date.now() - started,
      });
      return false;
    }

    const handled = Array.isArray(output?.handled) && output.handled.includes(failedId);
    if (handled) {
      context.outputs[candidate.id] = output;
      context.ran.add(candidate.id);
      this.completed.set(candidate.id, { status: STEP_STATUS.SUCCESS, output, step });
      logger.stepFinished(execution, step, {
        status: STEP_STATUS.SUCCESS,
        outputData: output,
        durationMs: Date.now() - started,
      });
      this.#applyBranchGates(candidate, output);
      return true;
    }

    this.completed.set(candidate.id, { status: STEP_STATUS.ERROR, error: 'branch did not handle the failure', step });
    logger.stepFinished(execution, step, {
      status: STEP_STATUS.ERROR,
      errorMessage: 'branch did not handle the failure',
      durationMs: Date.now() - started,
    });
    return false;
  }

  /** Validate + topo-sort; false (with this.validationError set) on failure. */
  #prepare() {
    const { workflow } = this;
    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      this.validationError = `Workflow validation failed: ${validation.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`;
      return false;
    }
    const sorted = topoSort(workflow);
    if (!sorted.ok) {
      this.validationError = `Workflow contains a cycle involving: ${sorted.cycle.join(', ')}`;
      return false;
    }
    if (sorted.order.length > this.defaults.MAX_NODES) {
      this.validationError = `Workflow has ${sorted.order.length} nodes; limit is ${this.defaults.MAX_NODES}.`;
      return false;
    }
    const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
    this.sortedNodes = sorted.order.map((id) => byId.get(id));
    return true;
  }

  /** Persist the terminal run state. */
  #finalize(status, errorMessage) {
    const durationMs = Date.now() - this.startedAtMs;
    return this.logger.executionStatus(this.execution, {
      status,
      finishedAt: new Date().toISOString(),
      durationMs,
      errorMessage,
    });
  }
}
