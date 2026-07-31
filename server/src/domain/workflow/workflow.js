/**
 * workflow.js — the Workflow aggregate.
 *
 * A Workflow is a directed acyclic graph of nodes. Each node is an agent step
 * that depends on zero or more upstream nodes. The aggregate protects two
 * invariants (enforced in validateWorkflow.js): node ids are unique, and the
 * dependency graph is acyclic. Edges are *derived* from `dependsOn` so there is
 * a single source of truth for the graph shape.
 */

/** Node types the executor understands. Kept small on purpose. */
export const NODE_TYPES = Object.freeze(['input', 'agent', 'tool', 'branch', 'output']);

/**
 * @typedef {Object} WorkflowNode
 * @property {string} id
 * @property {string} type      One of NODE_TYPES.
 * @property {string} name
 * @property {Object} [config]
 * @property {string[]} dependsOn  Ids of upstream nodes.
 */

/**
 * @typedef {Object} Workflow
 * @property {string} id
 * @property {string} name
 * @property {WorkflowNode[]} nodes
 */

/** Derive the edge list [{from, to}] from node dependencies. */
export function edgesOf(workflow) {
  const edges = [];
  for (const node of workflow.nodes) {
    for (const dep of node.dependsOn ?? []) {
      edges.push({ from: dep, to: node.id });
    }
  }
  return edges;
}

/** Nodes with no dependencies — the entry points of a run. */
export function rootNodes(workflow) {
  return workflow.nodes.filter((n) => (n.dependsOn ?? []).length === 0);
}

/** Nodes that nothing depends on — the terminal outputs of a run. */
export function leafNodes(workflow) {
  const depended = new Set();
  for (const n of workflow.nodes) for (const d of n.dependsOn ?? []) depended.add(d);
  return workflow.nodes.filter((n) => !depended.has(n.id));
}
