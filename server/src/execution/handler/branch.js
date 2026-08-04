/**
 * handler/branch.js — branch node: decide which path the run takes next.
 *
 * Three complementary mechanisms, in priority order:
 *   1. config.conditions — [{ when: {nodeId|field|text, op, value}, then: nodeId }].
 *      The first matching condition names the node that continues; all other
 *      direct dependents of the branch are gated (skipped).
 *   2. config.decisions — { [nodeId]: boolean | 'yes' | 'no' } — an explicit
 *      per-dependent gate map (no `next` needed).
 *   3. Error-handling role (Inc 1 compatibility): a branch whose config
 *      declares config.handles (node ids or '*') or config.onError runs after
 *      a dependency fails; its output records which failures it handled and
 *      the engine treats a handled failure as recovered.
 *
 * The output shape drives the engine's gating:
 *   { next: string|null, matched: number, decisions: Record<string,boolean>,
 *     handled: string[], warnings: string[] }
 */

import { checkRule, handlesError, serializeContext } from '../../domain/executor/handlers.js';
import { deepGet } from './util.js';

/** Compare `actual` against `expected` using the condition operator. */
export function compare(actual, op, expected) {
  switch (op ?? 'eq') {
    case 'eq':
    case 'equals':
      return String(actual) === String(expected);
    case 'neq':
    case 'not-equals':
      return String(actual) !== String(expected);
    case 'gt':
      return Number(actual) > Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'contains':
      return String(actual ?? '').includes(String(expected));
    case 'in': {
      const list = Array.isArray(expected) ? expected : String(expected).split(',');
      return list.map(String).includes(String(actual));
    }
    default:
      throw new Error(`branch: unknown condition operator "${op}"`);
  }
}

/** Evaluate one `when` clause against the run context. */
export function evaluateWhen(when, ctx, contextText) {
  if (!when || typeof when !== 'object') return false;
  if (when.nodeId) {
    return compare(ctx.get(when.nodeId), when.op, when.value);
  }
  if (when.field) {
    return compare(deepGet(JSON.parse(contextText), when.field), when.op, when.value);
  }
  if (when.text !== undefined) {
    const needle = String(when.text);
    return when.op === 'not-contains' ? !contextText.includes(needle) : contextText.includes(needle);
  }
  return false;
}

/**
 * @param {object} ctx engine context
 * @returns {Promise<{ node_id: string, next: string|null, matched: number,
 *   decisions: Record<string, boolean>, handled: string[], warnings: string[] }>}
 */
export async function branchHandler(ctx) {
  const config = ctx.node.config ?? {};
  const contextText = serializeContext(ctx);

  // 1. Conditional next: first matching condition wins.
  let next = null;
  let matched = -1;
  const conditions = Array.isArray(config.conditions) ? config.conditions : [];
  for (let i = 0; i < conditions.length; i += 1) {
    if (evaluateWhen(conditions[i].when, ctx, contextText)) {
      next = conditions[i].then ?? null;
      matched = i;
      break;
    }
  }

  // 2. Explicit per-dependent gate map.
  const decisions = {};
  for (const [nodeId, v] of Object.entries(config.decisions ?? {})) {
    decisions[nodeId] = typeof v === 'string' ? v === 'yes' || v === 'true' : Boolean(v);
  }

  // 3. Edge-case warnings + error-handling audit trail (Inc 1 compatible).
  const warnings = [];
  const cases = Array.isArray(config.cases) ? config.cases : [];
  for (const edge of cases) {
    if (checkRule(edge, contextText)) warnings.push(`edge case detected: ${edge}`);
  }
  const handled = [];
  for (const failedId of Object.keys(ctx.errors)) {
    if (handlesError(ctx.node, failedId)) handled.push(failedId);
  }

  return {
    node_id: ctx.node.id,
    next,
    matched,
    decisions,
    handled,
    warnings,
  };
}
