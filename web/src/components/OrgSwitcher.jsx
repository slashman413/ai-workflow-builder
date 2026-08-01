/**
 * OrgSwitcher.jsx — organization workspace switching.
 *
 * Clerk mode: renders the orgs the signed-in user belongs to and calls
 * `setActive` on change (Clerk re-mints a session token carrying the new
 * `org_id` claim). Mock mode: the same list/set behavior over the dev
 * shell's state.
 */

import React from 'react';
import { useAppAuth } from '../auth/AuthProvider.jsx';

export function OrgSwitcher() {
  const { orgs, activeOrg, setActiveOrg, isLoaded, isSignedIn } = useAppAuth();

  if (!isLoaded || !isSignedIn || orgs.length === 0) return null;

  return (
    <label className="org-switcher">
      <span className="org-label">Workspace</span>
      <select value={activeOrg?.id ?? ''} onChange={(e) => setActiveOrg(e.target.value)} aria-label="Switch workspace">
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
    </label>
  );
}
