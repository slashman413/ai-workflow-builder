/**
 * roles.js — the RBAC model shared by the UI. Mirrors the backend's
 * role mapping in server/src/adapters/http/auth.js: Clerk's `org_role`
 * claim maps onto Owner > Architect > Viewer, and unknown roles fail
 * closed (null → no access).
 */

export const ROLE_LEVELS = Object.freeze({ owner: 3, architect: 2, viewer: 1 });

export const ROLE_LABELS = Object.freeze({
  owner: 'Owner',
  architect: 'Architect',
  viewer: 'Viewer',
});

const CLAIM_TO_ROLE = Object.freeze({
  'org:owner': 'owner',
  'org:admin': 'owner',
  'org:architect': 'architect',
  'org:editor': 'architect',
  'org:viewer': 'viewer',
  'org:member': 'viewer',
});

/** Map a Clerk org_role claim to an app role name; null when unknown. */
export function roleFromClaim(claim) {
  return CLAIM_TO_ROLE[claim] ?? null;
}

export function hasRole(role, min) {
  if (!role || !ROLE_LEVELS[min]) return false;
  return ROLE_LEVELS[role] >= ROLE_LEVELS[min];
}
