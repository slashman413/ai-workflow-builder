import React from 'react';

/** DeployButton — trigger the one-click deploy (or dry-run preview). */
export function DeployButton({ onClick, busy, disabled, dryRun }) {
  return (
    <button type="button" className="primary" onClick={onClick} disabled={disabled || busy}>
      {busy ? 'Working…' : dryRun ? 'Preview config' : 'Deploy now'}
    </button>
  );
}
