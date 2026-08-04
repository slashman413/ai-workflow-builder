import React from 'react';

/** RunButton — start (and stream) a run of the saved workflow. */
export function RunButton({ onClick, disabled, running, freeTier }) {
  const title = freeTier
    ? 'Running workflows requires the Team plan'
    : running
      ? 'A run is in progress'
      : 'Execute the saved workflow now';
  return (
    <button type="button" className="primary" onClick={onClick} disabled={disabled} title={title}>
      {running ? 'Running…' : '▶ Run workflow'}
    </button>
  );
}
