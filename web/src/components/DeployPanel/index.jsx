import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client.js';
import { PlatformSelector } from './PlatformSelector.jsx';
import { DeployButton } from './DeployButton.jsx';
import { DeployStatus } from './DeployStatus.jsx';

/**
 * DeployPanel.jsx — Increment 5 one-click deploy.
 *
 * Pick a platform (Cloudflare Workers / Fly.io / Docker), optionally preview
 * the generated config with dry-run, then deploy. The result shows the
 * assigned URL and the generated scaffold files; the history lists previous
 * deployments. Free plan is gated (402 server-side, disabled here).
 */
export function DeployPanel({ projectId, canEdit, entitlement, onEntitlementChanged }) {
  const [platform, setPlatform] = useState('cloudflare');
  const [dryRun, setDryRun] = useState(true);
  const [deployment, setDeployment] = useState(null);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const freeTier = entitlement?.limits?.executions === false;

  const refresh = () => api.deploys.list(projectId).then(setHistory).catch(() => setHistory([]));
  useEffect(() => {
    refresh();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const deploy = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const dep = await api.deploys.create(projectId, { platform, dryRun });
      setDeployment(dep);
      setMessage(dryRun ? `Dry-run complete — ${Object.keys(dep.config ?? {}).length} config file(s) generated.` : `Deployed to ${dep.url}`);
      api.telemetry.capture('deployment_created', { count: 1 }).catch(() => {});
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card deploy-panel">
      <div className="exec-head">
        <h3>One-click deploy</h3>
        {freeTier && <span className="readonly-note">Team plan required</span>}
      </div>
      <p className="canvas-hint">
        Generate a deployable scaffold (wrangler.toml / fly.toml / Dockerfile) from the saved workflow and get a
        deployment URL.
      </p>

      {error && <div className="error" role="alert">{error}</div>}
      {message && <p className="done">{message}</p>}

      <div className="deploy-controls">
        <PlatformSelector value={platform} onChange={setPlatform} disabled={!canEdit || freeTier} />
        <label className="deploy-dryrun">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={!canEdit || freeTier} />
          dry-run (preview config, no scaffold)
        </label>
        <DeployButton onClick={deploy} busy={busy} disabled={!canEdit || freeTier} dryRun={dryRun} />
      </div>

      {deployment && <DeployStatus deployment={deployment} />}

      {history.length > 0 && (
        <div className="exec-history">
          <h4>Deployment history</h4>
          <ul>
            {history.map((d) => (
              <li key={d.id} className="exec-history-row">
                <button type="button" className="project-row" onClick={() => setDeployment(d)}>
                  <span className={`exec-status exec-status-${d.status}`}>{d.status}</span>
                  <span className="project-title">{d.platform}</span>
                  <span className="project-meta">
                    {d.url ?? 'no url'}
                    {' · '}
                    {new Date(d.createdAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
