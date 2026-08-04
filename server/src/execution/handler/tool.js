/**
 * handler/tool.js — tool node: execute a marketplace tool.
 *
 * A tool node runs ONE of three things, in priority order:
 *   1. a built-in tool pinned by config.tool_id / config.tool
 *      (see BUILTIN_TOOLS in types.js — http.request, web.fetch, web.search,
 *      rule.check, json.transform),
 *   2. the legacy Inc 1 rule-check semantics when config.constraints /
 *      config.criteria are present (pure string checks over the context),
 *   3. an external webhook when config.url is set (POST the context).
 *
 * Anything else is REFUSED with a clear error — the runtime never guesses
 * what an unknown tool id should do. `ctx.fetchFn` and `ctx.signal` are
 * injected so tests run network-free and cancellation aborts in-flight calls.
 */

import { checkRule, serializeContext } from '../../domain/executor/handlers.js';
import { deepGet } from './util.js';

/** Execute the json.transform built-in over the accumulated context. */
function jsonTransform(ctx, config) {
  const operation = config.operation ?? 'pick';
  const data = config.input ?? JSON.parse(serializeContext(ctx));
  switch (operation) {
    case 'pick': {
      const paths = Array.isArray(config.paths) ? config.paths : [config.path];
      const picked = {};
      for (const p of paths) picked[p] = deepGet(data, p);
      return { operation, picked };
    }
    case 'omit': {
      const omit = new Set(Array.isArray(config.paths) ? config.paths : [config.path]);
      const kept = {};
      for (const [k, v] of Object.entries(data)) if (!omit.has(k)) kept[k] = v;
      return { operation, kept };
    }
    case 'count':
      return { operation, count: Array.isArray(data) ? data.length : Object.keys(data ?? {}).length };
    case 'keys':
      return { operation, keys: Object.keys(data ?? {}) };
    case 'merge':
      return { operation, merged: { ...data, ...(config.extra ?? {}) } };
    default:
      throw new Error(`json.transform: unknown operation "${operation}" (pick|omit|count|keys|merge)`);
  }
}

/** The built-in tool implementations. Each is (ctx, config) => value. */
export const BUILTIN_TOOL_IMPL = {
  'http.request': async (ctx, config) => {
    const url = config.url;
    if (typeof url !== 'string' || !url) throw new Error('http.request: config.url is required');
    const res = await ctx.fetchFn(url, {
      method: config.method ?? 'GET',
      headers: config.headers ?? {},
      body: config.body != null ? JSON.stringify(config.body) : undefined,
      signal: ctx.signal,
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, ok: res.ok, body: text.slice(0, 100_000) };
  },

  'web.fetch': async (ctx, config) => {
    const url = config.url;
    if (typeof url !== 'string' || !url) throw new Error('web.fetch: config.url is required');
    const res = await ctx.fetchFn(url, { signal: ctx.signal });
    if (!res.ok) throw new Error(`web.fetch: HTTP ${res.status} for ${url}`);
    return { url, content: (await res.text()).slice(0, 100_000) };
  },

  'web.search': async (ctx, config) => {
    const endpoint = config.endpoint;
    if (typeof endpoint !== 'string' || !endpoint) {
      throw new Error('web.search: config.endpoint is required (a search API URL that accepts ?q=)');
    }
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(String(config.query ?? ''))}`;
    const res = await ctx.fetchFn(url, { signal: ctx.signal });
    if (!res.ok) throw new Error(`web.search: HTTP ${res.status}`);
    return { query: config.query, results: await res.json() };
  },

  'rule.check': (ctx, config) => {
    const rules = Array.isArray(config.rules) ? config.rules : [];
    const text = serializeContext(ctx);
    const results = {};
    for (const rule of rules) results[rule] = checkRule(rule, text);
    return { results, passed: Object.values(results).every(Boolean) };
  },

  'json.transform': (ctx, config) => jsonTransform(ctx, config),
};

/**
 * @param {object} ctx engine context
 * @returns {Promise<unknown>} the tool result
 */
export async function toolHandler(ctx) {
  const config = ctx.node.config ?? {};
  const nodeId = ctx.node.id;

  // 1. Built-in marketplace tool.
  const toolId = config.tool_id ?? config.tool;
  if (toolId && BUILTIN_TOOL_IMPL[toolId]) {
    return { tool: toolId, result: await BUILTIN_TOOL_IMPL[toolId](ctx, config) };
  }

  // 2. Legacy rule-check semantics (Inc 1 default handler compatibility).
  const rules = Array.isArray(config.constraints)
    ? config.constraints
    : Array.isArray(config.criteria)
      ? config.criteria
      : null;
  if (rules) {
    const text = serializeContext(ctx);
    const results = {};
    for (const rule of rules) results[rule] = checkRule(rule, text);
    return { results, passed: Object.values(results).every(Boolean) };
  }

  // 3. External webhook — POST the accumulated context to config.url.
  if (config.url) {
    const res = await ctx.fetchFn(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serializeContext(ctx),
      signal: ctx.signal,
    });
    return { webhook: config.url, status: res.status, ok: res.ok };
  }

  throw new Error(
    `tool node "${nodeId}": no implementation — pin a built-in tool (config.tool_id), ` +
      'set config.constraints/criteria, or set config.url for a webhook.',
  );
}
