/**
 * types.js — shared constants for the Increment 5 execution engine.
 *
 * The engine is the PRODUCTION runtime for a workflow DAG: unlike the safe
 * mock simulation (Increment 3), it executes the built-in node handlers
 * (input/agent/tool/branch/output) with real I/O. The Increment 3 safety
 * invariant still holds in spirit: ONLY these built-in handlers ever run —
 * there is no user-code execution surface, no arbitrary command runner.
 */

/** Node types the engine can execute. */
export const NODE_TYPES = Object.freeze(['input', 'agent', 'tool', 'branch', 'output']);

/** Execution (run) state machine. */
export const EXECUTION_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED: 'paused',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/** Per-step state machine. */
export const STEP_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCESS: 'success',
  ERROR: 'error',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
});

/** Engine defaults — every one is overridable per run or per node. */
export const DEFAULTS = Object.freeze({
  /** Per-step timeout (ms). Override per node with config.timeoutMs. */
  STEP_TIMEOUT_MS: 60_000,
  /** Max steps running at once. Override per run with { concurrency }. */
  CONCURRENCY: 4,
  /** Max retries per step. Override per node with config.retries. */
  MAX_RETRIES: 0,
  /** Base backoff between retries (ms), doubled per attempt. */
  RETRY_BACKOFF_MS: 500,
  /** Upper bound on nodes per run — defense against maliciously huge DAGs. */
  MAX_NODES: 500,
  /** Cap on the input/output JSON stored per step (dashboard payloads). */
  MAX_STORED_PAYLOAD_CHARS: 65_536,
});

/** One-click deploy platforms (see DeployService / DeployPanel). */
export const PLATFORMS = Object.freeze(['cloudflare', 'fly', 'docker']);

/** Deployment statuses. */
export const DEPLOYMENT_STATUS = Object.freeze({
  DRY_RUN: 'dry_run',
  DEPLOYING: 'deploying',
  DEPLOYED: 'deployed',
  FAILED: 'failed',
});

/** LLM providers the agent handler can call (keys come from the key vault). */
export const PROVIDERS = Object.freeze({
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  deepseek: 'deepseek',
});

/** Default model per provider when a node does not pin one. */
export const DEFAULT_MODELS = Object.freeze({
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: 'gemini-2.0-flash',
  deepseek: 'deepseek-chat',
});

/**
 * Built-in marketplace tools the tool handler can execute. A tool node pins
 * one via config.tool_id (or the legacy config.tool). Anything outside this
 * set (and outside the legacy rule-check/webhook paths) is REFUSED — the
 * runtime never guesses.
 */
export const BUILTIN_TOOLS = Object.freeze({
  'http.request': {
    label: 'HTTP request',
    description: 'Make an HTTP request (method, url, headers, body).',
  },
  'web.fetch': {
    label: 'Fetch URL',
    description: 'Fetch a URL and return its text content.',
  },
  'web.search': {
    label: 'Web search',
    description: 'Search the web via a configured search endpoint.',
  },
  'rule.check': {
    label: 'Rule check',
    description: 'Check that every significant word of each rule appears in the context.',
  },
  'json.transform': {
    label: 'JSON transform',
    description: 'Pick / omit / merge / count / keys over the accumulated context JSON.',
  },
});
