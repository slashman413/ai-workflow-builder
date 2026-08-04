import React from 'react';

/**
 * StepPanel.jsx — expandable input/output view for one executed step.
 *
 * Shows the node's status, duration, retry attempts, and expandable JSON
 * blocks for the input snapshot (what the node read) and the output (what it
 * produced). Failed steps highlight the error message prominently.
 */
function JsonBlock({ title, value }) {
  if (value === null || value === undefined) return null;
  const text = JSON.stringify(value, null, 2);
  return (
    <details className="step-json" open={text.length < 800}>
      <summary>{title}</summary>
      <pre className="config">{text}</pre>
    </details>
  );
}

export function StepPanel({ step }) {
  if (!step) {
    return (
      <div className="step-panel">
        <h4>Step detail</h4>
        <p className="empty">Select a node in the pipeline or timeline to inspect its input and output.</p>
      </div>
    );
  }
  const { nodeId, nodeType, status, inputData, outputData, errorMessage, durationMs, attempts } = step;
  return (
    <div className="step-panel">
      <h4>
        Step <code>{nodeId}</code>
        <span className={`exec-status exec-status-${status}`}>{status}</span>
      </h4>
      <dl className="step-meta">
        <dt>type</dt><dd><code>{nodeType}</code></dd>
        <dt>duration</dt><dd>{durationMs != null ? `${(durationMs / 1000).toFixed(2)}s` : '—'}</dd>
        <dt>attempts</dt><dd>{attempts ?? 1}</dd>
      </dl>
      {errorMessage && (
        <div className="step-error" role="alert">
          <strong>Error:</strong> {errorMessage}
        </div>
      )}
      <JsonBlock title="Input (what this step read)" value={inputData} />
      <JsonBlock title="Output (what this step produced)" value={outputData} />
    </div>
  );
}
