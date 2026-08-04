/**
 * handler/output.js — output node: deliver the run result.
 *
 * Mirrors the Inc 1 default handler semantics: each `config.targets` entry
 * resolves to a webhook POST (https?://), an email draft (.eml written under
 * the run's data dir), or a JSON file under the data dir. `ctx.dataDir` is
 * injected per run so deliverables never escape the execution sandbox.
 */

import { deliverTarget, serializeContext } from '../../domain/executor/handlers.js';

/**
 * @param {object} ctx engine context
 * @returns {Promise<Record<string, string>>} map of target -> delivery note
 */
export async function outputHandler(ctx) {
  const config = ctx.node.config ?? {};
  const targets = Array.isArray(config.targets) ? config.targets : [];
  const payload = serializeContext(ctx);
  const delivered = {};
  for (const target of targets) {
    delivered[target] = await deliverTarget(target, payload, ctx.dataDir);
  }
  return delivered;
}
