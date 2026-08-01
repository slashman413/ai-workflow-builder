/**
 * BillingBadge.jsx — the plan/usage indicator + upgrade affordance
 * (Increment 4).
 *
 * Reads the org's effective entitlement (GET /billing/entitlement) and
 * renders:
 *   - the tier label (Free / Trial / Team)
 *   - Grill sessions left this month for Free
 *   - an Upgrade button → Stripe Checkout (or a note when Stripe is not
 *     configured on the deployment — mock mode)
 *   - a Manage subscription link for paid tiers (billing portal)
 *
 * Data is deliberately display-only: quota ENFORCEMENT happens server-side
 * (EntitlementService), this badge just tells the user where they stand.
 */

import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';

export function BillingBadge({ onChanged }) {
  const [entitlement, setEntitlement] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.billing
      .entitlement()
      .then((e) => alive && setEntitlement(e))
      .catch(() => alive && setEntitlement(null));
    return () => { alive = false; };
  }, []);

  const upgrade = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.billing.checkout('team');
      if (url) window.location.href = url;
      else setEntitlement(await api.billing.entitlement());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      onChanged?.();
    }
  };

  const manage = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.billing.portal();
      if (url) window.location.href = url;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!entitlement) return null; // offline / not configured — badge is optional

  const { tier, label, limits, usage, billing } = entitlement;
  const isPaid = tier !== 'free';
  const sessionsLeft =
    limits.grillSessionsPerMonth == null
      ? null
      : Math.max(0, limits.grillSessionsPerMonth - usage.grillSessionsThisMonth);

  return (
    <div className={`billing-badge tier-${tier}`} data-tier={tier}>
      <span className="billing-tier" title={billing.status ?? 'no subscription'}>
        {tier === 'team' ? '🏅' : tier === 'trial' ? '🧪' : '🆓'} {label}
      </span>
      {sessionsLeft != null && (
        <span className="billing-quota" title="Grill sessions left this month (Free plan)">
          {sessionsLeft}/{limits.grillSessionsPerMonth} Grill sessions left
        </span>
      )}
      {isPaid && (
        <button type="button" className="ghost billing-manage" onClick={manage} disabled={busy}>
          Manage
        </button>
      )}
      {!isPaid && (
        <button type="button" className="billing-upgrade" onClick={upgrade} disabled={busy}>
          {busy ? 'Opening…' : `Upgrade — Team $99/mo`}
        </button>
      )}
      {error && <span className="billing-error" role="alert">{error}</span>}
    </div>
  );
}
