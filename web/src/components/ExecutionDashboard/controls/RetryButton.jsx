import React from 'react';

/** RetryButton — re-run the last (or a specific) finished execution. */
export function RetryButton({ onClick, disabled }) {
  return (
    <button type="button" className="ghost" onClick={onClick} disabled={disabled} title="Re-run as a new execution (history is append-only)">
      ↻ Retry run
    </button>
  );
}
