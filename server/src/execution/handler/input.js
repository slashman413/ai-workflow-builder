/**
 * handler/input.js — input node: load data into the run context.
 *
 * Semantics mirror the generated Python runtime and the Inc 1 default
 * handler: each `config.sources` entry resolves to a value, either from
 * user-supplied run inputs (config.mode === 'user') or by loading the
 * source (HTTP(S) URL, existing local file, or literal string).
 */

import { loadSource } from '../../domain/executor/handlers.js';

/**
 * @param {object} ctx Engine context — see engine.js for the full shape.
 * @returns {Promise<Record<string, unknown>>} map of source -> loaded value
 */
export async function inputHandler(ctx) {
  const config = ctx.node.config ?? {};
  const sources = Array.isArray(config.sources) ? config.sources : [];
  const collected = {};
  for (const source of sources) {
    if (config.mode === 'user') {
      // Run inputs win; config.values is the fallback for pre-filled nodes.
      const value = ctx.inputs?.[ctx.node.id]?.[source] ?? config.values?.[source];
      if (value === undefined) {
        throw new Error(`input node "${ctx.node.id}": user input required for "${source}" but no value was provided`);
      }
      collected[source] = value;
    } else {
      collected[source] = await loadSource(source, ctx.fetchFn);
    }
  }
  return collected;
}
