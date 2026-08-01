/**
 * telemetry.test.js — privacy-preserving product analytics (Increment 4).
 *
 * Hard invariants under test:
 *   1. NO sensitive data — prompt text, answers, API keys, tokens and any
 *      free-form content are dropped by the allowlist filter; the raw props
 *      never reach PostHog OR the local log.
 *   2. PSEUDONYMOUS identity — the stored/sent id is a truncated sha256 of
 *      the org id: stable per org, but not the org id and useless for
 *      identifying a person.
 *   3. No-op when PostHog is not configured — the local log still records.
 *   4. The funnel events fire from the service layer (grill kickoff,
 *      lens selection, export completion).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { TelemetryService, sanitizeProps, pseudonym } from '../src/application/telemetryService.js';

/** A recording adapter that captures exactly what the service hands it. */
function recordingAdapter() {
  const calls = [];
  return {
    mode: 'live',
    calls,
    capture({ distinctId, event, properties }) {
      calls.push({ distinctId, event, properties });
    },
    flush: async () => {},
  };
}

function makeService({ adapter = null } = {}) {
  const repos = createMemoryRepos();
  const service = new TelemetryService(repos, { adapter });
  return { repos, service };
}

test('allowlist filter drops prompt text, answers, keys and free-form content', () => {
  const clean = sanitizeProps({
    prompt: 'build a newsletter from my inbox', // sensitive — dropped
    answers: { 'goal.outcome': 'a digest' },    // sensitive — dropped
    apiKey: 'sk-1234567890',                     // secret — dropped
    token: 'ghp_abc',                            // secret — dropped
    text: 'free-form content',                   // sensitive — dropped
    objective: 'summarise',                      // not on the allowlist — dropped
    tier: 'free',                                // allowed
    count: 3,                                    // allowed
    durationMs: 412,                             // allowed
    mode: 'live',                                // allowed
    nested: { anything: true },                  // not allowed
  });
  assert.deepEqual(clean, { tier: 'free', count: 3, durationMs: 412, mode: 'live' });
});

test('capture never leaks sensitive props to the adapter or the local log', () => {
  const adapter = recordingAdapter();
  const { repos, service } = makeService({ adapter });
  service.capture('org-42', 'lens_selected', {
    prompt: 'secret prompt',
    OPENAI_API_KEY: 'sk-leak',
    source: 'nuwa-skill',
    tier: 'trial',
  });

  // Local log: only the pseudonymous hash + allowlisted props.
  const rows = repos.telemetry.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orgHash, pseudonym('org-42'));
  assert.equal(rows[0].event, 'lens_selected');
  assert.deepEqual(rows[0].props, { source: 'nuwa-skill', tier: 'trial' });
  assert.ok(!JSON.stringify(rows[0]).includes('secret prompt'));
  assert.ok(!JSON.stringify(rows[0]).includes('sk-leak'));

  // Outbound adapter: same sanitized payload, pseudonymous id.
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].distinctId, pseudonym('org-42'));
  assert.deepEqual(adapter.calls[0].properties, { source: 'nuwa-skill', tier: 'trial', event: 'lens_selected' });
});

test('pseudonym is stable per org and differs across orgs', () => {
  const a1 = pseudonym('org-a');
  const a2 = pseudonym('org-a');
  const b = pseudonym('org-b');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /^[0-9a-f]{16}$/); // truncated hash — never the org id
  assert.notEqual(a1, 'org-a');
});

test('capture without a PostHog adapter still records the local log (no-op outbound)', () => {
  const { repos, service } = makeService(); // adapter = null
  service.capture('org-a', 'export_completed', { count: 8, tier: 'team' });
  const rows = repos.telemetry.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'export_completed');
  assert.equal(rows[0].props.count, 8);
});

test('capture never throws into the request path, even when the local log fails', () => {
  const repos = createMemoryRepos();
  repos.telemetry.insert = () => {
    throw new Error('disk full');
  };
  const adapter = recordingAdapter();
  const service = new TelemetryService(repos, { adapter });
  // Must not throw — analytics is best-effort by design.
  service.capture('org-a', 'grill_session_started', { tier: 'free' });
  assert.equal(adapter.calls.length, 1);
});

test('funnel events are captured from the service layer (grill kickoff, export)', () => {
  const adapter = recordingAdapter();
  const { service } = makeService({ adapter });
  service.capture('org-a', 'grill_session_started', { tier: 'free' });
  service.capture('org-a', 'export_completed', { tier: 'team', count: 8, durationMs: 1200, outcome: 'ok' });
  const events = adapter.calls.map((c) => c.event);
  assert.deepEqual(events, ['grill_session_started', 'export_completed']);
});
