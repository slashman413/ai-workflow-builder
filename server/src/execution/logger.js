/**
 * logger.js — persistence + realtime fan-out for execution events.
 *
 * Every state transition of a run is written to the SQLite ledger
 * (executions / execution_steps via the injected repos) AND broadcast to
 * subscribers of that execution's SSE stream through the shared hub. The
 * engine never touches HTTP; it emits events here and the routes layer
 * forwards them to connected dashboards.
 *
 * The hub is a tiny pub/sub keyed by execution id. Subscribers are the SSE
 * response writers created by GET /projects/:id/run/:execId/events.
 */

import { randomUUID } from 'node:crypto';
import { DEFAULTS, STEP_STATUS } from './types.js';

/** Create the shared event hub (one per ExecutionService). */
export function createHub() {
  /** @type {Map<string, Set<Function>>} execId -> subscriber set */
  const subscribers = new Map();
  return {
    subscribe(execId, cb) {
      if (!subscribers.has(execId)) subscribers.set(execId, new Set());
      subscribers.get(execId).add(cb);
      return cb;
    },
    unsubscribe(execId, cb) {
      subscribers.get(execId)?.delete(cb);
      if (subscribers.get(execId)?.size === 0) subscribers.delete(execId);
    },
    /** Broadcast one event object ({ type, data }) to an execution's stream. */
    emit(execId, event) {
      for (const cb of [...(subscribers.get(execId) ?? [])]) {
        try {
          cb(event);
        } catch (err) {
          // A dead subscriber must never take down the run.
          console.error('[execution] subscriber error:', err.message);
        }
      }
    },
    active(execId) {
      return subscribers.get(execId)?.size ?? 0;
    },
  };
}

/** Truncate a JSON payload before it is stored (dashboard-sized rows). */
export function capPayload(value, max = DEFAULTS.MAX_STORED_PAYLOAD_CHARS) {
  if (value === undefined || value === null) return value;
  const text = JSON.stringify(value);
  if (text.length <= max) return value;
  const truncated = JSON.parse(text.slice(0, max));
  return { ...truncated, __truncated: true };
}

/**
 * Create the execution logger. All methods are synchronous (repos are sync).
 *
 * @param {object} deps
 * @param {any} deps.executions ExecutionRepository
 * @param {any} deps.executionSteps ExecutionStepRepository
 * @param {ReturnType<typeof createHub>} [deps.hub]
 * @param {() => Date} [deps.now]
 */
export function createLogger({ executions, executionSteps, hub = createHub(), now = () => new Date() }) {
  /** Update the execution row + broadcast the run status. */
  function executionStatus(execution, patch) {
    const updated = executions.update(execution.orgId, execution.id, {
      ...patch,
      ...(patch.finishedAt || patch.startedAt ? {} : {}),
    });
    hub.emit(execution.id, { type: 'execution', data: updated ?? { ...execution, ...patch } });
    return updated ?? { ...execution, ...patch };
  }

  /** Create the step row (status running) + broadcast. */
  function stepStarted(execution, { nodeId, nodeType, inputData }) {
    const step = executionSteps.insert({
      id: randomUUID(),
      orgId: execution.orgId,
      executionId: execution.id,
      nodeId,
      nodeType,
      status: STEP_STATUS.RUNNING,
      inputData: capPayload(inputData),
      outputData: null,
      errorMessage: null,
      attempts: 1,
      durationMs: null,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    hub.emit(execution.id, { type: 'step', data: step });
    return step;
  }

  /** Update the step row with the outcome + broadcast. */
  function stepFinished(execution, step, { status, outputData = null, errorMessage = null, durationMs = null, attempts = step.attempts }) {
    const updated = executionSteps.update(execution.orgId, step.id, {
      status,
      outputData: outputData !== null ? capPayload(outputData) : null,
      errorMessage: errorMessage?.slice(0, 2000) ?? null,
      durationMs,
      attempts,
    });
    hub.emit(execution.id, { type: 'step', data: updated ?? { ...step, status } });
    return updated ?? { ...step, status };
  }

  /**
   * Record a node that never ran (skipped by a branch gate / aborted run /
   * cancelled execution) directly with its terminal status.
   */
  function stepSkipped(execution, { nodeId, nodeType, status, errorMessage = null }) {
    const step = executionSteps.insert({
      id: randomUUID(),
      orgId: execution.orgId,
      executionId: execution.id,
      nodeId,
      nodeType,
      status,
      inputData: null,
      outputData: null,
      errorMessage,
      attempts: 1,
      durationMs: 0,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    hub.emit(execution.id, { type: 'step', data: step });
    return step;
  }

  return {
    hub,
    executionStatus,
    stepStarted,
    stepFinished,
    stepSkipped,
  };
}
