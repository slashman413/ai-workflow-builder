/**
 * posthogAdapter.js — the PostHog outbound adapter (Increment 4).
 *
 * Two modes:
 *   - 'live': POSTHOG_API_KEY is set — captures go to PostHog cloud.
 *   - 'off' : not configured — every capture is a local no-op (the
 *     TelemetryService still records the local privacy-safe log).
 *
 * The adapter is deliberately dumb: it forwards whatever the service hands
 * it. ALL sanitization (allowlisting, pseudonymization) happens in
 * TelemetryService, so a future capture path cannot accidentally leak a
 * prompt by going around the service.
 */

import { PostHog } from 'posthog-node';

export function createPosthogAdapter({ apiKey = null, host = 'https://us.i.posthog.com' } = {}) {
  const client =
    apiKey ? new PostHog(apiKey, { host, flushAt: 20, flushInterval: 2000 }) : null;

  return {
    mode: client ? 'live' : 'off',
    /** Fire-and-forget capture; never throws into the request path. */
    capture({ distinctId, event, properties = {} }) {
      if (!client) return;
      try {
        client.capture({ distinctId, event, properties, timestamp: new Date() });
      } catch (err) {
        console.warn('[telemetry] posthog capture failed (non-fatal):', err.message);
      }
    },
    /** Best-effort flush (shutdown / after batch events). */
    flush() {
      if (!client) return Promise.resolve();
      return client.flush().catch(() => {});
    },
  };
}
