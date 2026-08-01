/**
 * specBuilder.js — compile a raw prompt + grill answers into a structured Spec.
 *
 * The Spec is the contract between the "grill me" feature and the workflow
 * builder: everything downstream reads the Spec, never the raw prompt. Keeping
 * this a pure transformation means a Spec can be re-derived at any time from its
 * (prompt, answers) pair — the source of truth stays small.
 */

import { assessReadiness } from '../grill/grillEngine.js';
import { DIMENSIONS } from '../grill/questionBank.js';

/**
 * @typedef {Object} Spec
 * @property {string} goal
 * @property {string} why
 * @property {string[]} inputs
 * @property {string[]} outputs
 * @property {string[]} constraints
 * @property {string[]} successCriteria
 * @property {string[]} edgeCases
 * @property {boolean} ready
 * @property {string[]} openQuestions   Dimensions still uncovered.
 */

function pick(answers, id, fallback = '') {
  const v = answers?.[id];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/** Split a free-text answer into list items on newlines / semicolons / commas. */
function toList(text) {
  if (!text) return [];
  return text
    .split(/[\n;]|,(?=\s)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} prompt
 * @param {Record<string,string>} [answers]
 * @returns {Spec}
 */
export function buildSpec(prompt, answers = {}) {
  const readiness = assessReadiness(prompt, answers);
  const goal = pick(answers, 'goal.outcome', prompt.trim());
  return {
    goal,
    why: pick(answers, 'goal.why'),
    inputs: toList(pick(answers, 'inputs.source') || pick(answers, 'inputs.shape')),
    outputs: toList(pick(answers, 'outputs.shape') || pick(answers, 'outputs.destination')),
    constraints: toList(pick(answers, 'constraints.hard')),
    successCriteria: toList(pick(answers, 'success.measure')),
    edgeCases: toList(pick(answers, 'edge_cases.failure')),
    ready: readiness.ready,
    openQuestions: [...readiness.missing, ...readiness.warnings].map(
      (id) => DIMENSIONS.find((d) => d.id === id)?.label ?? id,
    ),
  };
}

/**
 * Suggest a starter workflow from a Spec. This is intentionally simple and
 * transparent — one node per spec dimension, chained in execution order —
 * giving the user something concrete to react to in the builder rather than a
 * blank canvas. The chain is deterministic (same spec → same nodes) and the
 * linear dependency order makes it acyclic by construction.
 *
 * Dimension → node mapping:
 *   spec.inputs          → input node  (collects the sources)
 *   spec.goal            → agent node  (the main AI agent)
 *   spec.constraints     → tool node   (constraint checker)
 *   spec.edgeCases       → branch node (error handling)
 *   spec.successCriteria → tool node   (validation)
 *   spec.outputs         → output node (delivers the results)
 *
 * Empty dimensions are skipped, so a bare prompt yields the minimal
 * input → agent → output chain (3 nodes) and a fully specified spec yields 6.
 *
 * @param {Spec} spec
 * @returns {import('../workflow/workflow.js').WorkflowNode[]}
 */
export function suggestNodes(spec) {
  const inputs = spec?.inputs ?? [];
  const outputs = spec?.outputs ?? [];
  const constraints = spec?.constraints ?? [];
  const successCriteria = spec?.successCriteria ?? [];
  const edgeCases = spec?.edgeCases ?? [];

  const nodes = [];
  /** Depend on whatever node precedes us in the chain — always acyclic. */
  const dependsOnLast = () => (nodes.length === 0 ? [] : [nodes[nodes.length - 1].id]);

  nodes.push({
    id: 'input.collect',
    type: 'input',
    name: 'Collect inputs',
    config: { sources: [...inputs] },
    dependsOn: dependsOnLast(),
  });
  nodes.push({
    id: 'agent.goal',
    type: 'agent',
    name: 'Achieve the goal',
    config: { objective: spec?.goal || '' },
    dependsOn: dependsOnLast(),
  });
  if (constraints.length > 0) {
    nodes.push({
      id: 'tool.constraints',
      type: 'tool',
      name: 'Check constraints',
      config: { constraints: [...constraints] },
      dependsOn: dependsOnLast(),
    });
  }
  if (edgeCases.length > 0) {
    nodes.push({
      id: 'branch.edgeCases',
      type: 'branch',
      name: 'Handle edge cases',
      config: { cases: [...edgeCases] },
      dependsOn: dependsOnLast(),
    });
  }
  if (successCriteria.length > 0) {
    nodes.push({
      id: 'tool.validation',
      type: 'tool',
      name: 'Validate success criteria',
      config: { criteria: [...successCriteria] },
      dependsOn: dependsOnLast(),
    });
  }
  nodes.push({
    id: 'output.deliver',
    type: 'output',
    name: 'Emit outputs',
    config: { targets: [...outputs] },
    dependsOn: dependsOnLast(),
  });

  return nodes;
}
