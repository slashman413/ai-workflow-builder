import React from 'react';

/**
 * Timeline.jsx — chronological step log for the current run.
 *
 * Every step event appears in order with a status badge and duration;
 * clicking an entry selects it in the StepPanel. The execution's terminal
 * status (success/failure/cancel) is pinned at the top when available.
 */
export function Timeline({ steps, onSelect, selectedNodeId, execution }) {
  const ordered = [...steps].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  return (
    <div className="timeline">
      <h4>Timeline</h4>
      {execution?.errorMessage && <div className="step-error" role="alert">Run failed: {execution.errorMessage}</div>}
      {ordered.length === 0 ? (
        <p className="empty">No steps yet — the run has not started dispatching.</p>
      ) : (
        <ol className="timeline-list">
          {ordered.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`timeline-row ${selectedNodeId === s.nodeId ? 'selected' : ''}`}
                onClick={() => onSelect(s.nodeId)}
              >
                <span className={`exec-status exec-status-${s.status}`}>{s.status}</span>
                <code>{s.nodeId}</code>
                <span className="project-meta">
                  {s.durationMs != null ? `${(s.durationMs / 1000).toFixed(2)}s` : '—'}
                  {s.attempts > 1 ? ` · ${s.attempts} attempts` : ''}
                </span>
              </button>
              {s.errorMessage && <p className="timeline-error">{s.errorMessage}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
