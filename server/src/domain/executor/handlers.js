/**
 * handlers.js — default node handlers for the workflow executor.
 *
 * Each handler is an async function of (context, node):
 *   context — the shared run context (upstream outputs, env, error records)
 *   node    — the WorkflowNode being executed
 *
 * Handlers are the plugin point of the executor: swap any of them per run by
 * passing `handlers: { agent: ... }` to executeWorkflow. The defaults mirror
 * the Python code generator's node semantics so a workflow behaves the same
 * whether it runs through this runtime or through the compiled main.py:
 *
 *   input   → data loading (URL / file / literal / user-supplied value)
 *   agent   → LLM call via OpenAI (or Anthropic), keyed off OPENAI_API_KEY /
 *             ANTHROPIC_API_KEY from context.env
 *   tool    → rule checks (constraints / success criteria)
 *   branch  → edge-case detection + error handling for failed nodes
 *   output  → deliver results (file, email draft, webhook)
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Default model per provider when a node does not pin one. */
export const DEFAULT_MODELS = Object.freeze({
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
});

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';
const DEFAULT_MAX_TOKENS = 1024;

/* ---------------------------------------------------------------------------
 * Shared helpers (exported so tests and custom handlers can reuse them)
 * ------------------------------------------------------------------------ */

/** JSON-serialize the outputs collected so far (BigInt-safe, like str() in py). */
export function serializeContext(context) {
  return JSON.stringify(context.outputs ?? {}, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/** Compose the LLM prompt from the node objective and the current context. */
export function buildPrompt(objective, contextText) {
  return (
    `Objective: ${objective}\n\n` +
    `Context so far:\n${contextText}\n\n` +
    'Produce the best possible result for the objective.'
  );
}

/**
 * Load one input source: HTTP(S) URL, existing local file, or literal value.
 * Mirrors the generated Python `_load_source`.
 */
export async function loadSource(source, fetchFn = fetch) {
  if (typeof source !== 'string') return source;
  if (/^https?:\/\//.test(source)) {
    const res = await fetchFn(source);
    if (!res.ok) throw new Error(`Failed to fetch ${source}: HTTP ${res.status}`);
    return res.text();
  }
  if (existsSync(source)) return readFile(source, 'utf8');
  return source;
}

/**
 * Call the OpenAI chat completions API via fetch. `fetchFn` is injectable so
 * the default handler stays testable without network access.
 */
export async function callOpenAI({ apiKey, body, fetchFn = fetch }) {
  const res = await fetchFn('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/** Call the Anthropic messages API via fetch. `fetchFn` is injectable. */
export async function callAnthropic({ apiKey, body, fetchFn = fetch }) {
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return (data.content ?? []).map((part) => part.text ?? '').join('');
}

/**
 * Heuristic rule check, mirroring the generated Python `_check_rule`: every
 * significant word (length > 3) of the rule must appear in the context text.
 */
export function checkRule(rule, contextText) {
  const text = String(contextText).toLowerCase();
  const words = String(rule)
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  return words.every((w) => text.includes(w));
}

/** Deliver results to a webhook, an email draft, or a JSON file. */
export async function deliverTarget(target, payload, dir = 'outputs', fetchFn = fetch) {
  const slug =
    String(target)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'output';
  if (/^https?:\/\//.test(target)) {
    const res = await fetchFn(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, payload: safeParse(payload) }),
    });
    if (!res.ok) throw new Error(`Webhook ${target} failed: HTTP ${res.status}`);
    return `webhook ${target} -> ${res.status}`;
  }
  await mkdir(dir, { recursive: true });
  if (target.includes('@')) {
    const path = join(dir, `${slug}.eml`);
    await writeFile(path, `To: ${target}\nSubject: Workflow result\n\n${payload}\n`, 'utf8');
    return `email draft written to ${path}`;
  }
  const path = join(dir, `${slug}.json`);
  await writeFile(path, payload, 'utf8');
  return `file written to ${path}`;
}

/**
 * Does this branch node declare responsibility for a failed node's error?
 * A branch handles failures when `config.handles` lists the node id (or '*')
 * or when `config.onError` is true.
 */
export function handlesError(branchNode, failedNodeId) {
  const handles = branchNode?.config?.handles;
  if (Array.isArray(handles)) return handles.includes(failedNodeId) || handles.includes('*');
  return branchNode?.config?.onError === true;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ---------------------------------------------------------------------------
 * Default handlers
 * ------------------------------------------------------------------------ */

export const defaultHandlers = {
  /** input — load data from URL / file / literal / user-supplied value. */
  async input(context, node) {
    const config = node.config ?? {};
    const sources = Array.isArray(config.sources) ? config.sources : [];
    const collected = {};
    for (const source of sources) {
      if (config.mode === 'user') {
        const value = config.values?.[source];
        if (value === undefined) {
          throw new Error(
            `input node "${node.id}": user input required for "${source}" but no value was provided`,
          );
        }
        collected[source] = value;
      } else {
        collected[source] = await loadSource(source, config.fetchFn);
      }
    }
    return collected;
  },

  /** agent — call OpenAI (or Anthropic) with a prompt built from context. */
  async agent(context, node) {
    const config = node.config ?? {};
    const provider = config.provider === 'anthropic' ? 'anthropic' : 'openai';
    const objective = config.objective || node.name || 'achieve the goal';
    const prompt = buildPrompt(objective, serializeContext(context));

    if (provider === 'anthropic') {
      const apiKey = context.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(`agent node "${node.id}": ANTHROPIC_API_KEY is not set`);
      }
      return callAnthropic({
        apiKey,
        body: {
          model: config.model ?? DEFAULT_MODELS.anthropic,
          max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        },
        fetchFn: config.fetchFn,
      });
    }

    const apiKey = context.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(`agent node "${node.id}": OPENAI_API_KEY is not set`);
    }
    return callOpenAI({
      apiKey,
      body: {
        model: config.model ?? DEFAULT_MODELS.openai,
        messages: [
          { role: 'system', content: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: config.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
      fetchFn: config.fetchFn,
    });
  },

  /** tool — run rule checks (constraints / success criteria) over context. */
  async tool(context, node) {
    const config = node.config ?? {};
    const rules = Array.isArray(config.constraints)
      ? config.constraints
      : Array.isArray(config.criteria)
        ? config.criteria
        : [];
    const results = {};
    const text = serializeContext(context);
    for (const rule of rules) results[rule] = checkRule(rule, text);
    return { results, passed: Object.values(results).every(Boolean) };
  },

  /** branch — detect edge cases and collect errors it is responsible for. */
  async branch(context, node) {
    const config = node.config ?? {};
    const cases = Array.isArray(config.cases) ? config.cases : [];
    const report = { node_id: node.id, errors: [], warnings: [], handled: [] };
    const text = serializeContext(context);
    for (const edge of cases) {
      if (checkRule(edge, text)) report.warnings.push(`edge case detected: ${edge}`);
    }
    // Error-handling role: surface every failure this branch handles.
    for (const failedId of Object.keys(context.errors)) {
      if (handlesError(node, failedId)) {
        report.errors.push(`${failedId}: ${context.errors[failedId].message}`);
        report.handled.push(failedId);
      }
    }
    return report;
  },

  /** output — save/finalize the result (file, email draft, webhook). */
  async output(context, node) {
    const config = node.config ?? {};
    const targets = Array.isArray(config.targets) ? config.targets : [];
    const dir = config.dir ?? 'outputs';
    const payload = serializeContext(context);
    const delivered = {};
    for (const target of targets) {
      delivered[target] = await deliverTarget(target, payload, dir);
    }
    return delivered;
  },
};
