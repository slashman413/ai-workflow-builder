/**
 * GithubExportPanel.jsx — the repository export surface (Increment 4).
 *
 * Three states:
 *   1. Not connected → "Connect GitHub" button. Opens the OAuth popup
 *      (GET /api/github/auth-url → GitHub authorize → callback postMessages
 *      the outcome back), then refreshes the connection status.
 *   2. Connected, Free tier → shows the paywall: export requires Team.
 *   3. Connected, Team/trial → repo name + visibility + "Export to GitHub".
 *
 * The server enforces the entitlement gate (402 PAYMENT_REQUIRED) — this
 * panel only surfaces it. On success it renders the repository URL and the
 * publication ledger row (file count, latency).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client.js';

const POPUP_MESSAGE_SOURCE = 'workflow-builders-github';

export function GithubExportPanel({ projectId, canEdit, entitlement, onEntitlementChanged }) {
  const [connection, setConnection] = useState(null); // { connected, login, scopes, publications }
  const [repoName, setRepoName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const popupRef = useRef(null);

  const refreshStatus = useCallback(() => {
    api.github
      .status()
      .then(setConnection)
      .catch(() => setConnection({ connected: false, login: null, scopes: [], publications: [] }));
  }, []);

  useEffect(() => {
    refreshStatus();
    // OAuth popup outcome: the callback page postMessages and closes.
    const onMessage = (event) => {
      const data = event.data ?? {};
      if (data?.source !== POPUP_MESSAGE_SOURCE) return;
      if (data.ok) {
        setError(null);
        refreshStatus();
      } else {
        setError(data.message ?? 'GitHub connection failed.');
      }
      if (popupRef.current) {
        try { popupRef.current.close(); } catch { /* already closed */ }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refreshStatus]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.github.authUrl();
      const w = 640;
      const h = 720;
      popupRef.current = window.open(
        url,
        'github-connect',
        `width=${w},height=${h},left=${Math.max(0, (window.screen.width - w) / 2)},top=${Math.max(0, (window.screen.height - h) / 2)}`,
      );
      if (!popupRef.current) setError('Popup blocked — allow popups for this site to connect GitHub.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.github.disconnect();
      setConnection({ connected: false, login: null, scopes: [], publications: [] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportRepo = async () => {
    if (!repoName.trim()) {
      setError('Give the repository a name first.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.publish(projectId, {
        repoName: repoName.trim(),
        private: isPrivate,
      });
      setResult(res);
      setRepoName('');
      refreshStatus();
      onEntitlementChanged?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PAYMENT_REQUIRED') {
        setError(`${e.message} — upgrade to Team to export.`);
        onEntitlementChanged?.();
      } else if (e instanceof ApiError && (e.code === 'GITHUB_NOT_CONNECTED' || e.code === 'GITHUB_AUTH_REQUIRED')) {
        setError(e.message);
        refreshStatus();
      } else {
        setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const tier = entitlement?.tier ?? null;
  const canExport = tier === 'team' || tier === 'trial';

  return (
    <section className="card export-panel">
      <div className="canvas-head">
        <h2>Export to GitHub</h2>
        {tier && <span className={`ver-badge ${canExport ? 'ok' : 'stale'}`}>{tier}</span>}
      </div>

      {!connection?.connected ? (
        <p className="empty">
          Publish your compiled multi-agent workflow to your own GitHub repository — with CI, typed
          interfaces and spec.yaml. Connect a GitHub account (repo scope) to start.
        </p>
      ) : (
        <p className="done">
          Connected as <strong>@{connection.login}</strong>
          {connection.scopes?.length ? ` (${connection.scopes.join(', ')})` : ''}
          {' — '}
          <button type="button" className="link" onClick={disconnect} disabled={busy}>disconnect</button>
        </p>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      {connection?.connected && !canExport && (
        <div className="paywall">
          <p>
            🏅 <strong>Repository export is a Team feature.</strong> Free plan includes 10 Grill
            sessions/month with mocked previews. Upgrade for unlimited Grill loops and one-click
            GitHub export.
          </p>
          <button type="button" className="billing-upgrade" onClick={() => onEntitlementChanged?.('upgrade')}>
            Upgrade — Team $99/mo
          </button>
        </div>
      )}

      {connection?.connected && canExport && canEdit && (
        <div className="export-form">
          <input
            type="text"
            placeholder="repository-name (letters, digits, - _ .)"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            aria-label="Repository name"
            maxLength={100}
          />
          <label className="export-private">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            Private repository
          </label>
          <button type="button" className="billing-upgrade" onClick={exportRepo} disabled={busy}>
            {busy ? 'Publishing…' : 'Export to GitHub'}
          </button>
        </div>
      )}

      {result && (
        <div className="sim-result">
          <h3>✓ {result.summary}</h3>
          <p>
            Repository: <a href={result.repoUrl} target="_blank" rel="noreferrer">{result.repoUrl}</a>
            <br />
            {result.fileCount} files, {result.branch} branch, commit{' '}
            <code>{result.sha?.slice(0, 7)}</code> in {result.latencyMs}ms.
          </p>
        </div>
      )}

      {connection?.publications?.length > 0 && (
        <details className="pub-ledger">
          <summary>Previous exports ({connection.publications.length})</summary>
          <ul>
            {connection.publications.map((p) => (
              <li key={p.id}>
                <a href={p.repoUrl} target="_blank" rel="noreferrer">{p.repoName}</a>
                {' — '}{p.fileCount} files · {new Date(p.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
