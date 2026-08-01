/**
 * RoleGate.jsx — RBAC view gate. Renders `children` only when the signed-in
 * user's role is at least `min`; otherwise renders `fallback` (or nothing).
 * Mirrors the backend's requireRole levels (owner 3 > architect 2 > viewer 1)
 * so the UI can never show an action the API would reject.
 */

import React from 'react';
import { useAppAuth } from '../auth/AuthProvider.jsx';
import { hasRole } from '../auth/roles.js';

export function RoleGate({ min = 'viewer', children, fallback = null }) {
  const { isSignedIn, role } = useAppAuth();
  if (!isSignedIn) return fallback;
  return hasRole(role?.name, min) ? children : fallback;
}
