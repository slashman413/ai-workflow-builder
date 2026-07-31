/**
 * validateWorkflow.js — enforce the Workflow aggregate's invariants.
 *
 * Returns a structured list of errors instead of throwing, so callers (HTTP
 * adapter, UI) can surface every problem at once. A workflow is only persisted
 * or "runnable" when this returns zero errors.
 */

import { NODE_TYPES } from './workflow.js';
import { topoSort } from './topoSort.js';

/**
 * @typedef {Object} ValidationError
 * @property {string} code
 * @property {string} message
 * @property {string} [nodeId]
 */

/**
 * @param {import('./workflow.js').Workflow} workflow
 * @returns {{ valid: boolean, errors: ValidationError[] }}
 */
export function validateWorkflow(workflow) {
  /** @type {ValidationError[]} */
  const errors = [];

  if (!workflow || typeof workflow !== 'object') {
    return { valid: false, errors: [{ code: 'NOT_AN_OBJECT', message: 'Workflow must be an object.' }] };
  }
  if (!Array.isArray(workflow.nodes)) {
    return { valid: false, errors: [{ code: 'NODES_NOT_ARRAY', message: 'workflow.nodes must be an array.' }] };
  }
  if (workflow.nodes.length === 0) {
    errors.push({ code: 'EMPTY', message: 'A workflow needs at least one node.' });
  }

  const seen = new Set();
  for (const node of workflow.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim()) {
      errors.push({ code: 'MISSING_ID', message: 'Every node needs a non-empty string id.' });
      continue;
    }
    if (seen.has(node.id)) {
      errors.push({ code: 'DUPLICATE_ID', message: `Duplicate node id "${node.id}".`, nodeId: node.id });
    }
    seen.add(node.id);

    if (!NODE_TYPES.includes(node.type)) {
      errors.push({
        code: 'BAD_TYPE',
        message: `Node "${node.id}" has unknown type "${node.type}". Expected one of: ${NODE_TYPES.join(', ')}.`,
        nodeId: node.id,
      });
    }
    if (node.dependsOn != null && !Array.isArray(node.dependsOn)) {
      errors.push({ code: 'BAD_DEPENDS_ON', message: `Node "${node.id}" dependsOn must be an array.`, nodeId: node.id });
    }
  }

  // Dependency references must resolve, and a node cannot depend on itself.
  for (const node of workflow.nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (dep === node.id) {
        errors.push({ code: 'SELF_DEPENDENCY', message: `Node "${node.id}" depends on itself.`, nodeId: node.id });
      } else if (!seen.has(dep)) {
        errors.push({
          code: 'DANGLING_DEPENDENCY',
          message: `Node "${node.id}" depends on unknown node "${dep}".`,
          nodeId: node.id,
        });
      }
    }
  }

  // Only bother with cycle detection once ids/deps are structurally sound.
  const structurallyOk = !errors.some((e) =>
    ['MISSING_ID', 'DUPLICATE_ID', 'DANGLING_DEPENDENCY', 'SELF_DEPENDENCY', 'NODES_NOT_ARRAY'].includes(e.code),
  );
  if (structurallyOk && workflow.nodes.length > 0) {
    const sorted = topoSort(workflow);
    if (!sorted.ok) {
      errors.push({
        code: 'CYCLE',
        message: `Workflow contains a cycle involving: ${sorted.cycle.join(', ')}.`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
