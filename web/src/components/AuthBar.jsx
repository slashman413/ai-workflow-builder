/**
 * AuthBar.jsx — the workspace header: sign-in shells (GitHub / Google OAuth),
 * org switching, the current role badge, and sign-out.
 *
 * In Clerk mode the OAuth buttons start a real Clerk OAuth redirect
 * (`authenticateWithRedirect`); in mock mode they flip the dev shell's
 * signed-in state. The "role switch" is mock-only — in production roles are
 * assigned in the Clerk dashboard by org owners.
 */

import React, { useState } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { useAppAuth } from '../auth/AuthProvider.jsx';
import { OrgSwitcher } from './OrgSwitcher.jsx';
import { RoleGate } from './RoleGate.jsx';

const PROVIDERS = [
  { id: 'oauth_github', name: 'GitHub', icon: '🐙' },
  { id: 'oauth_google', name: 'Google', icon: 'G' },
];

function ProviderRow({ onSignIn, busy, setBusy }) {
  const handle = async (p) => {
    setBusy(p.id);
    try {
      await onSignIn(p);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="oauth-row">
      {PROVIDERS.map((p) => (
        <button key={p.id} type="button" className="oauth-btn" disabled={busy !== null} onClick={() => handle(p)}>
          <span className="oauth-icon">{p.icon}</span>
          {busy === p.id ? 'Connecting…' : `Continue with ${p.name}`}
        </button>
      ))}
    </div>
  );
}

/** Clerk mode: real OAuth redirect through @clerk/clerk-react. */
function ClerkOAuthButtons() {
  const [busy, setBusy] = useState(null);
  const { isLoaded, signIn } = useSignIn();
  return (
    <ProviderRow
      busy={busy}
      setBusy={setBusy}
      onSignIn={async (p) => {
        if (isLoaded && signIn) {
          await signIn.authenticateWithRedirect({ strategy: p.id, redirectUrl: window.location.href });
        }
      }}
    />
  );
}

/** Mock mode: the dev shell accepts the provider id. */
function MockOAuthButtons({ onSignIn }) {
  const [busy, setBusy] = useState(null);
  return <ProviderRow busy={busy} setBusy={setBusy} onSignIn={async (p) => onSignIn(p.id)} />;
}

export function AuthBar() {
  const { mode, isLoaded, isSignedIn, userId, role, signOut, setRole, signIn } = useAppAuth();

  if (!isLoaded) {
    return <div className="auth-bar">Loading session…</div>;
  }

  if (!isSignedIn) {
    return (
      <div className="auth-bar">
        <div className="auth-shell">
          <h2>Sign in to your workspace</h2>
          <p className="auth-note">Your projects, workflows, and LLM keys are scoped to your organization.</p>
          {mode === 'clerk' ? <ClerkOAuthButtons /> : <MockOAuthButtons onSignIn={signIn} />}
          {mode === 'mock' && (
            <p className="dev-note">Dev shell — no VITE_CLERK_PUBLISHABLE_KEY set. Signing in simulates a Clerk session.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-bar signed-in">
      <OrgSwitcher />
      <span className={`role-badge role-${role?.name ?? 'none'}`} title="Your role in this workspace">
        {role?.label ?? 'No role'}
      </span>
      <span className="user-chip" title={userId}>
        {userId ?? 'user'}
      </span>
      {mode === 'mock' && (
        <RoleGate min="owner">
          <label className="role-switch">
            Demo role
            <select value={role?.name} onChange={(e) => setRole(e.target.value)} aria-label="Demo role">
              <option value="owner">Owner</option>
              <option value="architect">Architect</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
        </RoleGate>
      )}
      <button type="button" className="ghost signout" onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}
