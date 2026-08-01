/**
 * VaultPanel.jsx — the envelope-encrypted LLM key vault UI.
 *
 * Owner/Architect can list and store provider keys (OpenAI / Anthropic /
 * Gemini / DeepSeek); only owners can delete. The API never returns plaintext — the
 * panel renders the masked labels (`sk-proj-ab…9f2c`) and metadata only.
 * Viewers never see this panel (RoleGate min="architect"), matching the
 * backend's vault RBAC.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useAppAuth } from '../auth/AuthProvider.jsx';
import { RoleGate } from './RoleGate.jsx';

const PROVIDERS = ['openai', 'anthropic', 'gemini', 'deepseek'];

function VaultPanelInner() {
  const { activeOrg } = useAppAuth();
  const [entries, setEntries] = useState([]);
  const [provider, setProvider] = useState('openai');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setEntries(await api.vault.list());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [activeOrg?.id]);

  useEffect(() => {
    if (activeOrg) refresh();
  }, [activeOrg?.id, refresh]);

  const store = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.vault.store({ provider, label, apiKey });
      setApiKey('');
      setLabel('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    setBusy(true);
    setError(null);
    try {
      await api.vault.remove(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card vault">
      <h2>🔐 LLM key vault</h2>
      <p className="vault-note">
        Stored with envelope encryption — a per-workspace data key wrapped by the server's key encryption key
        (AES-256-GCM). Keys are never shown in plaintext.
      </p>

      {error && <div className="error" role="alert">{error}</div>}

      <form className="vault-form" onSubmit={store}>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input type="text" placeholder="Label (e.g. prod)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
        <button type="submit" className="primary" disabled={busy || !apiKey.trim()}>
          Store key
        </button>
      </form>

      {entries.length === 0 ? (
        <p className="empty">No provider keys stored yet.</p>
      ) : (
        <ul className="vault-list">
          {entries.map((entry) => (
            <li key={entry.id} className="vault-entry">
              <div className="vault-meta">
                <span className="badge">{entry.provider}</span>
                <strong>{entry.label}</strong>
                <code className="masked">{entry.maskedKey}</code>
                <span className="vault-handle" title={entry.keyHandle}>
                  {entry.keyHandle.slice(0, 10)}…
                </span>
              </div>
              <RoleGate min="owner">
                <button type="button" className="ghost danger" disabled={busy} onClick={() => remove(entry.id)}>
                  Delete
                </button>
              </RoleGate>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function VaultPanel() {
  return (
    <RoleGate min="architect">
      <VaultPanelInner />
    </RoleGate>
  );
}
