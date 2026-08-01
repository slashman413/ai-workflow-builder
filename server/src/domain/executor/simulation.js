/**
 * simulation.js — the SAFE execution preview (Increment 3 safety invariant).
 *
 * The hard security rule of workflow-builders.com:
 *
 *   NO user-authored workflow code ever executes on our backend servers.
 *
 * The code generator produces Python that runs on the USER's machine. The
 * only thing this server ever does with a user's workflow DAG is:
 *
 *   1. static DAG validation (validateWorkflow — pure, no execution), and
 *   2. a MOCK-HANDLER topological simulation (this module — deterministic,
 *      side-effect-free, network-free, filesystem-free).
 *
 * Everything here is written to make the invariant checkable:
 *   - `simulateWorkflow` accepts NO handler injection — the mock handlers
 *     are closed over, so a caller cannot smuggle a real handler in.
 *   - The mock handlers perform zero I/O: no fetch, no file reads/writes,
 *     no child processes, no LLM calls. Input nodes echo placeholder
 *     values; agent nodes return a canned template; tool nodes do pure
 *     string checks; output nodes report delivery WITHOUT writing anything.
 *   - This module imports nothing from handlers.js/executor.js (the real
 *     runtime) — the safety test enforces that structurally.
 */

import { validateWorkflow } from '../workflow/validateWorkflow.js';
import { topoSort } from '../workflow/topoSort.js';

/** Upper bound on nodes per simulation — defense in depth against a
 * maliciously huge workflow. */
const MAX_SIMULATION_STEPS = 1000;

/**
 * Run the mock-handler simulation of a workflow DAG.
 *
 * @param {{ id?: string, name?: string, nodes: object[] }} workflow
 * @returns {Promise<{ success: boolean, simulation: boolean,
 *                      steps: Array<{ id, type, status, output?, error? }>,
 *                      errors: Array, error: string|null,
 *                      note: string }>}
 */
export async function simulateWorkflow(workflow) {
  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    const errors = validation.errors.map((e) => ({ nodeId: e.nodeId ?? null, message: `${e.code}: ${e.message}` }));
    return {
      success: false,
      simulation: true,
      steps: [],
      errors,
      error: `Workflow validation failed: ${errors.map((e) => e.message).join('; ')}`,
      note: 'Static DAG validation only — no user code executed.',
    };
  }

  const sorted = topoSort(workflow);
  if (!sorted.ok) {
    const message = `Workflow contains a cycle involving: ${sorted.cycle.join(', ')}`;
    return { success: false, simulation: true, steps: [], errors: [{ nodeId: null, message }], error: message, note: 'Static DAG validation only — no user code executed.' };
  }

  if (sorted.order.length > MAX_SIMULATION_STEPS) {
    const message = `Workflow has ${sorted.order.length} nodes; simulation limit is ${MAX_SIMULATION_STEPS}.`;
    return { success: false, simulation: true, steps: [], errors: [{ nodeId: null, message }], error: message, note: 'Mock-handler simulation refused (size cap).' };
  }

  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const context = createMockContext();
  const steps = [];
  const errors = [];

  for (const id of sorted.order) {
    const node = byId.get(id);
    try {
      const output = await runMock(node, context);
      context.outputs[id] = output;
      context.ran.add(id);
      steps.push({ id, type: node.type, status: 'success', output });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.errors[id] = { message };
      steps.push({ id, type: node.type, status: 'error', error: message });
      errors.push({ nodeId: id, message });
    }
  }

  return {
    success: errors.length === 0,
    simulation: true,
    steps,
    errors,
    error: errors.length ? errors[0].message : null,
    note: 'Mock-handler topological simulation — deterministic, zero I/O, no user code executed.',
  };
}

/* ---------------------------------------------------------------------------
 * Mock handlers — the ONLY handlers the simulation can ever run.
 * Each is a PURE function of (context, node): no network, no filesystem,
 * no LLM, no process spawning. Outputs are deterministic placeholders that
 * let the user preview data flow and ordering, never real side effects.
 * ------------------------------------------------------------------------ */

function createMockContext() {
  return {
    outputs: {},
    errors: {},
    ran: new Set(),
    get(id) {
      return this.outputs[id];
    },
  };
}

function runMock(node, context) {
  const config = node.config ?? {};
  switch (node.type) {
    case 'input': {
      const sources = Array.isArray(config.sources) ? config.sources : [];
      const collected = {};
      for (const source of sources) {
        collected[source] = config.mode === 'user'
          ? (config.values?.[source] ?? `[mock user input required: ${source}]`)
          : `[mock loaded ${source}]`;
      }
      return collected;
    }
    case 'agent': {
      const objective = config.objective || node.name || 'achieve the goal';
      const upstream = Object.keys(context.outputs).length;
      return `[mock agent "${node.id}"] Objective: ${objective}. Would call an LLM with ${upstream} upstream result(s).`;
    }
    case 'tool': {
      const rules = Array.isArray(config.constraints)
        ? config.constraints
        : Array.isArray(config.criteria)
          ? config.criteria
          : [];
      const text = JSON.stringify(context.outputs).toLowerCase();
      const results = {};
      for (const rule of rules) results[rule] = mockCheckRule(rule, text);
      return { results, passed: Object.values(results).every(Boolean), mock: true };
    }
    case 'branch': {
      const cases = Array.isArray(config.cases) ? config.cases : [];
      const warnings = cases.filter((c) => mockCheckRule(c, JSON.stringify(context.outputs).toLowerCase()));
      return { node_id: node.id, warnings, handled: Object.keys(context.errors), mock: true };
    }
    case 'output': {
      const targets = Array.isArray(config.targets) ? config.targets : [];
      const delivered = {};
      for (const target of targets) delivered[target] = `[mock delivered to ${target}]`;
      return delivered;
    }
    default:
      throw new Error(`No mock handler for node type "${node.type}" (node "${node.id}")`);
  }
}

/** Pure substring check mirroring the codegen's `_check_rule` (no I/O). */
function mockCheckRule(rule, text) {
  const words = String(rule)
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  return words.every((w) => text.includes(w));
}
