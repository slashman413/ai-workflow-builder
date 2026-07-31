/**
 * topoSort.js — Kahn's algorithm over a Workflow's dependency graph.
 *
 * Returns a valid execution order, or reports the cycle that makes one
 * impossible. This is the mechanism behind the "no cycles" invariant and also
 * the order a future executor would run steps in.
 */

/**
 * @param {import('./workflow.js').Workflow} workflow
 * @returns {{ ok: true, order: string[] } | { ok: false, cycle: string[] }}
 */
export function topoSort(workflow) {
  const ids = new Set(workflow.nodes.map((n) => n.id));
  /** @type {Map<string, string[]>} adjacency: dep -> [dependents] */
  const adj = new Map();
  const indegree = new Map();
  for (const n of workflow.nodes) {
    indegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const n of workflow.nodes) {
    for (const dep of n.dependsOn ?? []) {
      if (!ids.has(dep)) continue; // dangling deps handled by validateWorkflow
      adj.get(dep).push(n.id);
      indegree.set(n.id, indegree.get(n.id) + 1);
    }
  }

  // Seed with indegree-0 nodes, sorted for deterministic output.
  const queue = [...indegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id)
    .sort();

  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id).sort()) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        // insert keeping the queue sorted for determinism
        insertSorted(queue, next);
      }
    }
  }

  if (order.length !== workflow.nodes.length) {
    return { ok: false, cycle: findCycleNodes(indegree) };
  }
  return { ok: true, order };
}

function insertSorted(arr, value) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

/** Nodes left with indegree > 0 are exactly those trapped in/after a cycle. */
function findCycleNodes(indegree) {
  return [...indegree.entries()]
    .filter(([, d]) => d > 0)
    .map(([id]) => id)
    .sort();
}
