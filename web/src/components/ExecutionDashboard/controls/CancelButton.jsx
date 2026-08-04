import React from 'react';

/** CancelButton — abort the running execution (in-flight steps stop). */
export function CancelButton({ onClick, disabled }) {
  return (
    <button type="button" className="danger" onClick={onClick} disabled={disabled}>
      ■ Cancel run
    </button>
  );
}
