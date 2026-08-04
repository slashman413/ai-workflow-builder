/**
 * scheduler.js — executes ONE node with timeout, retry/backoff, and
 * cancellation semantics.
 *
 * The engine owns the DAG (ordering, concurrency, gating); this module owns
 * the per-step lifecycle:
 *   - a hard timeout per attempt (default 60s, per-node config.timeoutMs),
 *   - retries with exponential backoff (config.retries, config.retryBackoffMs),
 *   - cancellation: an AbortSignal that aborts the handler AND the in-flight
 *     fetch (handlers thread ctx.signal into fetchFn),
 *   - a run-level signal combined with the per-attempt timeout.
 *
 * Every attempt goes through the logger (step row + SSE event).
 */

import { DEFAULTS } from './types.js';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });

/**
 * Run one node to completion (all retries exhausted or a success).
 *
 * @param {object} params
 * @param {object} params.node the workflow node
 * @param {Function} params.handler (ctx) => Promise<unknown>
 * @param {object} params.ctx engine context handed to the handler
 * @param {object} params.logger execution logger (stepStarted/stepFinished)
 * @param {object} params.execution execution row
 * @param {AbortSignal} [params.signal] run-level cancellation signal
 * @param {object} [params.defaults] engine defaults override
 * @returns {Promise<{ status: 'success'|'error'|'cancelled', output?: unknown,
 *   error?: string, durationMs: number, attempts: number, step: object }>}
 */
export async function executeNode({ node, handler, ctx, logger, execution, signal, defaults = DEFAULTS }) {
  const config = node.config ?? {};
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : defaults.STEP_TIMEOUT_MS;
  const maxRetries = Number.isInteger(config.retries) ? config.retries : defaults.MAX_RETRIES;
  const baseBackoff = Number(config.retryBackoffMs) > 0 ? Number(config.retryBackoffMs) : defaults.RETRY_BACKOFF_MS;

  const step = logger.stepStarted(execution, {
    nodeId: node.id,
    nodeType: node.type,
    inputData: ctx.inputSnapshot ?? null,
  });

  const started = Date.now();
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attempts = attempt + 1;

    // Cancellation requested between attempts — stop without another run.
    if (signal?.aborted) {
      const final = logger.stepFinished(execution, step, {
        status: 'cancelled',
        errorMessage: 'execution cancelled',
        durationMs: Date.now() - started,
        attempts,
      });
      return { status: 'cancelled', durationMs: Date.now() - started, attempts, step: final };
    }

    // Combine the run-level signal with the per-attempt timeout. Node 18+
    // AbortSignal.any keeps both abort paths live for the handler's fetch.
    const attemptSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);

    try {
      // Refresh the step to 'running' (clears a previous attempt's error).
      logger.stepFinished(execution, step, {
        status: 'running',
        errorMessage: null,
        durationMs: Date.now() - started,
        attempts,
      });
      // Hard bound: the handler races the abort signal, so a misbehaving
      // handler (plain timers, long compute) is still cut off at timeoutMs
      // even when it never touches the signal itself.
      const output = await Promise.race([
        handler({ ...ctx, signal: attemptSignal }),
        new Promise((_resolve, reject) => {
          attemptSignal.addEventListener(
            'abort',
            () => {
              const cancelled = signal?.aborted === true;
              const err = new Error(cancelled ? 'execution cancelled' : `step timed out after ${timeoutMs}ms`);
              err.name = cancelled ? 'AbortError' : 'TimeoutError';
              reject(err);
            },
            { once: true },
          );
        }),
      ]);
      if (signal?.aborted) {
        const final = logger.stepFinished(execution, step, {
          status: 'cancelled',
          errorMessage: 'execution cancelled',
          durationMs: Date.now() - started,
          attempts,
        });
        return { status: 'cancelled', durationMs: Date.now() - started, attempts, step: final };
      }
      const final = logger.stepFinished(execution, step, {
        status: 'success',
        outputData: output,
        durationMs: Date.now() - started,
        attempts,
      });
      return { status: 'success', output, durationMs: Date.now() - started, attempts, step: final };
    } catch (err) {
      // Cancellation wins over retries — a cancelled run never retries.
      if (signal?.aborted) {
        const final = logger.stepFinished(execution, step, {
          status: 'cancelled',
          errorMessage: 'execution cancelled',
          durationMs: Date.now() - started,
          attempts,
        });
        return { status: 'cancelled', durationMs: Date.now() - started, attempts, step: final };
      }
      const timedOut = err?.name === 'TimeoutError';
      const message = timedOut ? `step timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
      if (timedOut) {
        logger.stepFinished(execution, step, {
          status: 'running',
          errorMessage: message,
          durationMs: Date.now() - started,
          attempts,
        });
      }
      if (attempt < maxRetries) {
        const backoff = baseBackoff * 2 ** attempt;
        await sleep(backoff, signal);
        continue;
      }
      const final = logger.stepFinished(execution, step, {
        status: 'error',
        errorMessage: message,
        durationMs: Date.now() - started,
        attempts,
      });
      return { status: 'error', error: message, durationMs: Date.now() - started, attempts, step: final };
    }
  }

  // Unreachable — the loop always returns.
  throw new Error(`executeNode: internal error for ${node.id}`);
}
