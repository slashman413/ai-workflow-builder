/**
 * executor.js — the workflow runtime.
 *
 * Executes a validated workflow DAG in topological order (via topoSort),
 * threading each node's output through a shared context object that dependent
 * nodes read from. Node types are pluggable: per-run `handlers` override the
 * defaults in handlers.js (e.g. a mock agent for testing).
 *
 * Error handling: when a node fails, the executor looks for branch nodes that
 * declare responsibility for it (config.handles / config.onError) and runs
 * them with the error recorded on the context. If an error-handling branch
 * recovers the failure, the run continues; otherwise the run aborts and the
 * remaining nodes are logged as skipped.
 *
 * Result shape:
 *   { success, steps: [{id, status, duration, output?, error?}], errors, error }
 *   status is 'success' | 'error' | 'skipped'.
 */

import { validateWorkflow } from '../workflow/validateWorkflow.js';
import { topoSort } from '../workflow/topoSort.js';
import { defaultHandlers, handlesError } from './handlers.js';

const now = () => Date.now();

/**
 * @param {Object} options
 * @param {import('../workflow/workflow.js').Workflow} options.workflow
 * @param {Record<string, (context, node) => Promise<unknown> | unknown>} [options.handlers]
 * @param {Record<string, string>} [options.env] Pass-through environment.
 * @returns {Promise<{success: boolean, steps: Array, errors: Array, error: string | null}>}
 */
export async function executeWorkflow({ workflow, handlers = {}, env = {} } = {}) {
  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    const errors = validation.errors.map((e) => ({
      nodeId: e.nodeId ?? null,
      message: `${e.code}: ${e.message}`,
    }));
    return {
      success: false,
      steps: [],
      errors,
      error: `Workflow validation failed: ${errors.map((e) => e.message).join('; ')}`,
    };
  }

  const sorted = topoSort(workflow);
  if (!sorted.ok) {
    const message = `Workflow contains a cycle involving: ${sorted.cycle.join(', ')}`;
    return { success: false, steps: [], errors: [{ nodeId: null, message }], error: message };
  }

  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const context = createContext({ env });
  const steps = [];
  const errors = [];
  const logged = new Set(); // node ids that already have a step entry
  const logStep = (step) => {
    logged.add(step.id);
    steps.push(step);
  };
  let aborted = false;

  for (const id of sorted.order) {
    // A branch that already ran as an error handler gets no second turn.
    if (context.ran.has(id)) continue;

    const node = byId.get(id);
    const handler = handlers[node.type] ?? defaultHandlers[node.type];
    const started = now();

    let failed = false;
    let message = '';
    if (typeof handler !== 'function') {
      failed = true;
      message = `No handler for node type "${node.type}" (node "${id}")`;
    } else {
      try {
        const output = await handler(context, node);
        context.outputs[id] = output;
        context.ran.add(id);
        logStep({ id, status: 'success', duration: now() - started, output });
      } catch (err) {
        failed = true;
        message = err instanceof Error ? err.message : String(err);
      }
    }
    if (!failed) continue;

    context.errors[id] = { message };
    logStep({ id, status: 'error', duration: now() - started, error: message });
    const recovered = await runErrorHandlers({ workflow, context, handlers, failedId: id, errors, logStep });
    errors.push({ nodeId: id, message, handled: recovered });
    if (!recovered) {
      aborted = true;
      break;
    }
  }

  if (aborted) {
    const abortedAt = steps.findLast((s) => s.status === 'error')?.id ?? '';
    for (const id of sorted.order) {
      if (logged.has(id)) continue;
      logStep({ id, status: 'skipped', duration: 0, error: `workflow aborted at "${abortedAt}"` });
    }
    const firstError = errors.find((e) => !e.handled) ?? errors[0];
    return { success: false, steps, errors, error: firstError?.message ?? 'Workflow aborted' };
  }

  return { success: true, steps, errors, error: null };
}

/**
 * Run every branch node that declares responsibility for the failed node and
 * whose dependencies are already satisfied (or is the failed node itself).
 * Returns true when at least one such branch ran successfully.
 */
async function runErrorHandlers({ workflow, context, handlers, failedId, errors, logStep }) {
  const candidates = workflow.nodes.filter((branch) => {
    if (branch.type !== 'branch' || branch.id === failedId || context.ran.has(branch.id)) return false;
    if (!handlesError(branch, failedId)) return false;
    // Dependents of the failed node may not have run yet — don't run early
    // unless every dependency is satisfied (failed node counts as satisfied).
    return (branch.dependsOn ?? []).every((dep) => context.ran.has(dep) || dep === failedId);
  });

  let handled = false;
  for (const branch of candidates) {
    const handler = handlers.branch ?? defaultHandlers.branch;
    const started = now();
    try {
      const output = await handler(context, branch);
      context.outputs[branch.id] = output;
      context.ran.add(branch.id);
      logStep({ id: branch.id, status: 'success', duration: now() - started, output });
      handled = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logStep({ id: branch.id, status: 'error', duration: now() - started, error: message });
      errors.push({ nodeId: branch.id, message, handled: false });
      return false; // the error handler itself failed → abort
    }
  }
  return handled;
}

/** Build the shared run context handlers read from. */
function createContext({ env }) {
  const outputs = {};
  const errors = {};
  const ran = new Set();
  return {
    env: { ...process.env, ...env },
    outputs,
    errors,
    ran,
    get: (id) => outputs[id],
    getError: (id) => errors[id],
  };
}
