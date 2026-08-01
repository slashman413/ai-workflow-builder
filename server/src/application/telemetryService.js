/**
 * telemetryService.js — privacy-preserving product analytics (Increment 4).
 *
 * Covers the user funnel: Grill session kickoff/completion, lens selections,
 * export completions, billing events. Two hard rules:
 *
 *   1. NO sensitive data — prompt text, answers, API keys, tokens, or any
 *      free-form user content NEVER reach analytics. Properties are filtered
 *      through an ALLOWLIST (not a denylist): anything not on the list is
 *      dropped, so a future call site cannot leak by forgetting to sanitize.
 *   2. PSEUDONYMOUS identity — the distinct id is a truncated sha256 of the
 *      org id, so the analytics system sees a stable, non-reversible-per-org
 *      identifier, never the org id, user id, email, or IP-derived data.
 *
 * Every event is ALSO appended to the local telemetry_events table (org_hash
 * only) so the product owns a privacy-safe copy even when PostHog is not
 * configured (mode 'off' — the adapter no-ops, the local log still records).
 */

import { createHash } from 'node:crypto';
import { assertOrg } from './errors.js';

/**
 * The ONLY property keys allowed through to analytics. Everything else is
 * dropped. Values are coerced to strings/numbers/booleans/null — a nested
 * object is stringified only if it is itself a safe scalar list.
 */
const ALLOWED_PROPS = new Set([
  'mode',            // adapter mode (mock/live) — publish/checkout
  'tier',            // free | trial | team
  'source',          // marketplace source id
  'count',           // files published, lenses rendered
  'durationMs',      // publish latency
  'outcome',         // ok | blocked | error
  'reason',          // stable error code (QUOTA_EXCEEDED, …)
  'preview',         // mock | simulated
  'lensCount',
  'agentCount',
  'division',
  'repoPrivate',
  'branch',
  'sessionTurn',
  'status',          // billing status (none|trialing|active|…)
]);

/** Events the product tracks. Kept as constants so call sites can't typo. */
export const EVENTS = Object.freeze({
  grillSessionStarted: 'grill_session_started',
  grillSessionCompleted: 'grill_session_completed',
  lensSelected: 'lens_selected',
  agentSelected: 'agent_selected',
  projectCreated: 'project_created',
  exportCompleted: 'export_completed',
  exportBlocked: 'export_blocked',
  checkoutStarted: 'checkout_started',
});

export class TelemetryService {
  /**
   * @param {{ telemetry: any }} repos
   * @param {object} [opts]
   * @param {object} [opts.adapter] PostHog adapter (createPosthogAdapter()).
   * @param {string} [opts.salt] Mixing salt for the pseudonymous id.
   */
  constructor(repos, { adapter = null, salt = 'workflow-builders' } = {}) {
    this.telemetryRepo = repos.telemetry;
    this.adapter = adapter;
    this.salt = salt;
  }

  /**
   * Capture one analytics event.
   *
   * @param {string} orgId
   * @param {string} event   One of EVENTS.
   * @param {object} [props] Raw properties — filtered through the allowlist.
   */
  capture(orgId, event, props = {}) {
    assertOrg(orgId);
    const clean = sanitizeProps(props);
    const distinctId = pseudonym(orgId, this.salt);
    // Local privacy-safe log — always recorded.
    try {
      this.telemetryRepo.insert({ orgHash: distinctId, event, props: clean });
    } catch (err) {
      console.warn('[telemetry] local log insert failed (non-fatal):', err.message);
    }
    // Outbound — no-op when PostHog is not configured.
    this.adapter?.capture({ distinctId, event, properties: { ...clean, event } });
  }

  /** Flush pending outbound events (server shutdown). */
  async flush() {
    await this.adapter?.flush?.();
  }
}

/**
 * Pseudonymous identity: sha256(salt:orgId)[:16] — stable per org, useless
 * for identifying a person. The full hash is never stored or sent.
 */
export function pseudonym(orgId, salt = 'workflow-builders') {
  return createHash('sha256').update(`${salt}:${orgId}`).digest('hex').slice(0, 16);
}

/** Allowlist filter: drop every key not in ALLOWED_PROPS, coerce scalars. */
export function sanitizeProps(raw = {}) {
  const out = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!ALLOWED_PROPS.has(key)) continue;
    if (value == null) out[key] = null;
    else if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    else if (Array.isArray(value) && value.every((v) => ['string', 'number'].includes(typeof v))) {
      out[key] = value.map(String);
    }
    // nested objects / functions are dropped — no serialization of unknowns
  }
  return out;
}
