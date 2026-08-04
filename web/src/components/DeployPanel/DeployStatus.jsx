import React from 'react';

/**
 * DeployStatus.jsx — the result of a deploy/dry-run: assigned URL, status,
 * and the generated scaffold files (expandable per-file).
 */
export function DeployStatus({ deployment }) {
  const { status, url, config, platform, errorMessage, createdAt } = deployment;
  return (
    <div className={`deploy-status deploy-status-${status}`}>
      <div className="deploy-status-head">
        <span className={`exec-status exec-status-${status}`}>{status}</span>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="deploy-url">
            {url}
          </a>
        )}
        <span className="project-meta">
          {platform} · {createdAt ? new Date(createdAt).toLocaleString() : ''}
        </span>
      </div>
      {errorMessage && <div className="step-error" role="alert">{errorMessage}</div>}
      {config && Object.keys(config).length > 0 && (
        <div className="deploy-configs">
          <h5>Generated scaffold</h5>
          {Object.entries(config).map(([name, contents]) => (
            <details key={name} className="step-json" open={Object.keys(config).length === 1}>
              <summary>{name}</summary>
              <pre className="config">{contents}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
