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
 * transparent — a linear ingest → process → deliver skeleton the user then
 * edits in the builder. It gives the user something concrete to react to
 * rather than a blank canvas.
 *
 * @param {Spec} spec
 * @returns {import('../workflow/workflow.js').WorkflowNode[]}
 */
export function suggestNodes(spec) {
  const nodes = [];
  nodes.push({
    id: 'ingest',
    type: 'input',
    name: 'Collect inputs',
    config: { describe: spec.inputs.join(', ') || 'user prompt' },
    dependsOn: [],
  });
  nodes.push({
    id: 'process',
    type: 'agent',
    name: 'Reason over inputs',
    config: { objective: spec.goal, constraints: spec.constraints },
    dependsOn: ['ingest'],
  });
  if (spec.successCriteria.length > 0) {
    nodes.push({
      id: 'verify',
      type: 'agent',
      name: 'Verify against success criteria',
      config: { criteria: spec.successCriteria },
      dependsOn: ['process'],
    });
  }
  nodes.push({
    id: 'deliver',
    type: 'output',
    name: 'Emit output',
    config: { format: spec.outputs.join(', ') || 'text' },
    dependsOn: [spec.successCriteria.length > 0 ? 'verify' : 'process'],
  });
  return nodes;
}
