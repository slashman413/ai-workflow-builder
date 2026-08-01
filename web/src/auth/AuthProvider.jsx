/**
 * AuthProvider.jsx — the single auth entry point for the app.
 *
 * Two interchangeable backends, one normalized context shape:
 *
 *   - Clerk mode  (VITE_CLERK_PUBLISHABLE_KEY set): full @clerk/clerk-react
 *     integration. Session JWTs are minted by Clerk, org switching calls
 *     `setActive`, and the API client sends the real `Authorization: Bearer`
 *     token — which the backend verifies cryptographically and reads
 *     `org_id` from.
 *   - Mock mode   (no key — local dev / preview without Clerk credentials):
 *     a dev shell that simulates the same surface: OAuth sign-in buttons,
 *     org switching, and a role selector for demoing the RBAC views. The
 *     API client sends `x-org-id` / `x-user-role` headers, which the
 *     backend's test mode accepts. Production never runs this mode.
 *
 * Whatever the mode, the current session token and org are pushed into the
 * API client via setAuth() so every request carries the caller's identity.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ClerkProvider, useAuth, useOrganizationList } from '@clerk/clerk-react';
import { setAuth } from '../api/client.js';
import { roleFromClaim, ROLE_LABELS } from './roles.js';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

export const AppAuthContext = createContext(null);

/** Access the normalized auth state anywhere in the tree. */
export const useAppAuth = () => useContext(AppAuthContext);

const roleView = (claim) => {
  const name = roleFromClaim(claim);
  return { name, label: name ? ROLE_LABELS[name] : 'No role' };
};

// --- Clerk mode --------------------------------------------------------------

function ClerkBridge({ children }) {
  const { isLoaded, isSignedIn, userId, orgId, orgRole, getToken, signOut } = useAuth();
  const { isLoaded: orgsLoaded, organizationList, setActive } = useOrganizationList();
  const [token, setToken] = useState(null);

  // Keep a fresh session token, re-minting after org switches (the org
  // claims are embedded in the token, so the token must follow the org).
  useEffect(() => {
    let live = true;
    if (isSignedIn) {
      getToken()
        .then((t) => live && setToken(t))
        .catch(() => live && setToken(null));
    } else {
      setToken(null);
    }
    return () => {
      live = false;
    };
  }, [isSignedIn, orgId, getToken]);

  // Push identity into the API client (authorization + tenant headers).
  useEffect(() => {
    setAuth({ token, orgId });
  }, [token, orgId]);

  const orgs = useMemo(
    () => (organizationList ?? []).map((o) => ({ id: o.organization.id, name: o.organization.name })),
    [organizationList],
  );
  const activeOrg = orgs.find((o) => o.id === orgId) ?? null;
  const role = roleView(orgRole);

  const value = {
    mode: 'clerk',
    isLoaded: isLoaded && orgsLoaded,
    isSignedIn,
    userId,
    orgId,
    orgs,
    activeOrg,
    role,
    setActiveOrg: (id) => setActive({ organization: id }),
    signOut: () => signOut(),
  };
  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

// --- Mock mode (dev shell, no Clerk credentials) ------------------------------

const MOCK_ORGS = [
  { id: 'org_demo', name: 'Acme Studio' },
  { id: 'org_demo_2', name: 'Northwind Labs' },
  { id: 'org_demo_3', name: 'Wayne Workspace' },
];
const MOCK_ROLES = ['owner', 'architect', 'viewer'];

function MockBridge({ children }) {
  const [isSignedIn, setSignedIn] = useState(false);
  const [orgId, setOrgId] = useState(MOCK_ORGS[0].id);
  const [roleName, setRoleName] = useState('owner');

  useEffect(() => {
    setAuth({ token: isSignedIn ? 'mock_session_token' : null, orgId: isSignedIn ? orgId : null });
  }, [isSignedIn, orgId]);

  const activeOrg = MOCK_ORGS.find((o) => o.id === orgId) ?? MOCK_ORGS[0];

  const value = {
    mode: 'mock',
    isLoaded: true,
    isSignedIn,
    userId: isSignedIn ? 'user_dev' : null,
    orgId: isSignedIn ? orgId : null,
    orgs: MOCK_ORGS,
    activeOrg: isSignedIn ? activeOrg : null,
    role: { name: roleName, label: ROLE_LABELS[roleName] },
    // Mock-only affordances: OAuth shells + an RBAC demo switch.
    signIn: (provider) => {
      setSignedIn(true);
      setOrgId(MOCK_ORGS[0].id);
      setRoleName('owner');
    },
    setActiveOrg: setOrgId,
    setRole: setRoleName,
    signOut: () => setSignedIn(false),
  };
  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

export function AuthProvider({ children }) {
  if (CLERK_KEY) {
    return (
      <ClerkProvider publishableKey={CLERK_KEY}>
        <ClerkBridge>{children}</ClerkBridge>
      </ClerkProvider>
    );
  }
  return <MockBridge>{children}</MockBridge>;
}
