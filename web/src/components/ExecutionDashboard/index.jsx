import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client.js';
import { PipelineView } from './PipelineView.jsx';
import { StepPanel } from './StepPanel.jsx';
import { Timeline } from './Timeline.jsx';
import { RunButton } from './controls/RunButton.jsx';
import { CancelButton } from './controls/CancelButton.jsx';
import { RetryButton } from './controls/RetryButton.jsx';

/** Terminal run states — the stream closes and control buttons disable. */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const ACTIVE = new Set(['queued', 'running', 'paused']);

/**
 * ExecutionDashboard.jsx — the Increment 5 run surface.
 *
 * Owns the live run state (execution row + per-step logs), streams updates
 * over SSE (fetch-based, auth headers intact), and renders:
 *   - controls: Run (saves the canvas first), Cancel, Pause/Resume, Retry
 *   - PipelineView: the React Flow graph with live per-node status
 *   - StepPanel: expandable input/output/error for the selected node
 *   - Timeline: chronological step log with durations
 *   - history: past runs, click to inspect, re-run, or retry
 *
 * Free plan: the API answers 402; the UI disables Run/Deploy and points at
 * the Team plan instead of firing doomed requests.
 */
export function ExecutionDashboard({ projectId, workflow, getWorkflow, canEdit, entitlement, onEntitlementChanged }) {
  const [execution, setExecution] = useState(null);
  const [steps, setSteps] = useState([]);
  const [history, setHistory] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const stopStreamRef = useRef(null);
  const streamRef = useRef(null); // holds the running stream fn for cleanup

  const freeTier = entitlement?.limits?.executions === false;

  const guard = (fn) => async (...args) => {
    setError(null);
    setMessage(null);
    try {
      return await fn(...args);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      return null;
    }
  };

  const refreshHistory = useCallback(() => {
    api.executions
      .list(projectId)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [projectId]);

  useEffect(() => {
    refreshHistory();
    return () => streamRef.current?.();
  }, [refreshHistory]);

  const attachStream = useCallback(
    (execId) => {
      streamRef.current?.();
      const stop = api.executions.stream(projectId, execId, {
        onEvent: (type, payload) => {
          if (type === 'execution') {
            setExecution((prev) => ({ ...(prev ?? {}), ...payload }));
            if (TERMINAL.has(payload.status)) {
              stopStreamRef.current?.();
              refreshHistory();
              setMessage(`Run ${execId.slice(0, 8)} finished: ${payload.status}.`);
            }
          } else if (type === 'step') {
            setSteps((prev) => {
              const idx = prev.findIndex((s) => s.id === payload.id);
              if (idx === -1) return [...prev, payload];
              const next = [...prev];
              next[idx] = payload;
              return next;
            });
          }
        },
      });
      stopStreamRef.current = stop;
      streamRef.current = stop;
    },
    [projectId, refreshHistory],
  );

  const run = guard(async () => {
    // Run executes the SAVED workflow — persist the canvas first.
    if (canEdit && getWorkflow) {
      await api.saveWorkflow(projectId, getWorkflow());
    }
    const exec = await api.executions.run(projectId, {});
    api.telemetry.capture('execution_started', { count: 1 }).catch(() => {});
    setExecution(exec);
    setSteps([]);
    setSelectedNodeId(null);
    attachStream(exec.id);
    setMessage(`Run ${exec.id.slice(0, 8)} started — streaming live step status.`);
  });

  const cancel = guard(async () => {
    if (!execution) return;
    await api.executions.cancel(projectId, execution.id);
    setMessage('Cancellation requested…');
  });

  const pause = guard(async () => {
    if (!execution) return;
    await api.executions.pause(projectId, execution.id);
    setMessage('Paused — in-flight steps will finish.');
  });

  const resume = guard(async () => {
    if (!execution) return;
    await api.executions.resume(projectId, execution.id);
    setMessage('Resumed.');
  });

  const retry = guard(async (execId) => {
    const exec = await api.executions.retry(projectId, execId ?? null);
    api.telemetry.capture('execution_retried', { count: 1 }).catch(() => {});
    setExecution(exec);
    setSteps([]);
    setSelectedNodeId(null);
    attachStream(exec.id);
    setMessage(`Retry ${exec.id.slice(0, 8)} started${exec.retryOf ? ` (retries ${exec.retryOf.slice(0, 8)})` : ''}.`);
  });

  const loadRun = guard(async (exec) => {
    stopStreamRef.current?.();
    const detail = await api.executions.get(projectId, exec.id);
    setExecution(detail);
    setSteps(detail.steps ?? []);
    setSelectedNodeId(null);
    if (ACTIVE.has(detail.status)) attachStream(detail.id);
  });

  const isActive = execution ? ACTIVE.has(execution.status) : false;
  const canRun = canEdit && !isActive && !freeTier;

  const selectedStep = steps.find((s) => s.nodeId === selectedNodeId) ?? null;

  return (
    <section className="card exec-dashboard">
      <div className="exec-head">
        <h3>Run &amp; execution dashboard</h3>
        {execution && (
          <span className={`exec-status exec-status-${execution.status}`}>
            {execution.status}
            {execution.durationMs != null && execution.durationMs > 0 && ` · ${(execution.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      {freeTier && (
        <p className="readonly-note">
          Running workflows and one-click deploys require the <strong>Team plan ($99/mo)</strong> — the Free plan is
          limited to safe simulations. {onEntitlementChanged && (
          <button type="button" className="ghost" onClick={() => api.billing.checkout().catch(() => {})}>
            Upgrade →
          </button>
        )}
        </p>
      )}

      {error && <div className="error" role="alert">{error}</div>}
      {message && <p className="done">{message}</p>}

      <div className="exec-controls">
        <RunButton onClick={run} disabled={!canRun} running={isActive} freeTier={freeTier} />
        {isActive && (
          <>
            <CancelButton onClick={cancel} />
            {execution.status === 'paused' ? (
              <button type="button" className="ghost" onClick={resume}>Resume</button>
            ) : (
              <button type="button" className="ghost" onClick={pause} disabled={execution.status !== 'running'}>Pause</button>
            )}
          </>
        )}
        {!isActive && execution && (
          <RetryButton onClick={() => retry(execution.id)} disabled={!canEdit || freeTier} />
        )}
      </div>

      <PipelineView workflow={workflow} steps={steps} executionStatus={execution?.status ?? null} onSelectNode={setSelectedNodeId} selectedNodeId={selectedNodeId} />

      <div className="exec-detail-grid">
        <StepPanel step={selectedStep} />
        <Timeline steps={steps} onSelect={setSelectedNodeId} selectedNodeId={selectedNodeId} execution={execution} />
      </div>

      <div className="exec-history">
        <h4>Execution history</h4>
        {history.length === 0 ? (
          <p className="empty">No runs yet — hit Run to execute this workflow.</p>
        ) : (
          <ul>
            {history.map((h) => (
              <li key={h.id} className="exec-history-row">
                <button type="button" className="project-row" onClick={() => loadRun(h)}>
                  <span className={`exec-status exec-status-${h.status}`}>{h.status}</span>
                  <span className="project-title">{h.id.slice(0, 12)}…</span>
                  <span className="project-meta">
                    {new Date(h.createdAt).toLocaleString()}
                    {h.durationMs != null ? ` · ${(h.durationMs / 1000).toFixed(1)}s` : ''}
                    {h.retryOf ? ` · retry of ${h.retryOf.slice(0, 8)}` : ''}
                  </span>
                </button>
                {h.status === 'failed' && (
                  <button type="button" className="ghost" onClick={() => retry(h.id)} disabled={!canEdit || freeTier}>
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
