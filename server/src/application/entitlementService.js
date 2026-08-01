/**
 * entitlementService.js — tier resolution + quota enforcement (Increment 4).
 *
 * The billing repo (owned by BillingService) mirrors Stripe's subscription
 * status; this service DERIVES the org's effective entitlement from it and
 * enforces the product rules from the brief:
 *
 *   - Free  : ≤ 10 Grill sessions per calendar month, mocked previews only,
 *             NO repository export, NO unlimited grill loops.
 *   - Trial : full access during the Stripe trial (or the trial window).
 *   - Team  : unlimited Grill loops + repository export ($99/mo).
 *
 * Enforcement happens HERE, in the service layer, so it cannot be bypassed by
 * calling the API directly — routes that gate on `assertGrillQuota` /
 * `assertExportAllowed` run before any money-moving or resource-consuming
 * work. Usage counters live in the `usage` repo (usage_events, monthly
 * period key YYYY-MM) and are recorded atomically per session kickoff.
 *
 * Tenancy: every method takes the caller's orgId (same identity the auth
 * choke point binds), so one org can never consume another org's quota.
 */

import { AppError, assertOrg } from './errors.js';

/** Product limits per tier (the billing plan catalogue lives in domain/billing/tiers.js). */
export const TIER_POLICY = Object.freeze({
  free: {
    id: 'free',
    label: 'Free',
    grillSessionsPerMonth: 10,
    exports: false,
    unlimitedGrill: false,
    preview: 'mock',
  },
  trial: {
    id: 'trial',
    label: 'Trial',
    grillSessionsPerMonth: null, // unlimited
    exports: true,
    unlimitedGrill: true,
    preview: 'simulated',
  },
  team: {
    id: 'team',
    label: 'Team',
    grillSessionsPerMonth: null, // unlimited
    exports: true,
    unlimitedGrill: true,
    preview: 'simulated',
  },
});

/** Stripe subscription statuses that map to paid/team access (past_due keeps access during dunning). */
const PAID_STATUSES = new Set(['active', 'past_due']);

/** The usage metric counted against the monthly Grill cap. */
export const GRILL_USAGE_METRIC = 'grill_session_started';
export const EXPORT_USAGE_METRIC = 'export_completed';

/** Current billing period key: 'YYYY-MM'. */
export function periodFor(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class EntitlementService {
  /**
   * @param {{ billing: any, usage: any }} repos
   * @param {object} [opts]
   * @param {() => Date} [opts.now]
   */
  constructor(repos, { now = () => new Date() } = {}) {
    this.billingRepo = repos.billing;
    this.usageRepo = repos.usage;
    this.now = now;
  }

  /**
   * Resolve the org's effective tier from the billing row.
   * @returns {'free'|'trial'|'team'}
   */
  resolveTier(orgId) {
    const row = this.billingRepo.getByOrg(orgId);
    const status = row?.status ?? 'none';
    if (PAID_STATUSES.has(status)) return 'team';
    if (status === 'trialing') return 'trial';
    // Edge: a subscription was canceled but the trial window has not elapsed.
    if (row?.trialEnd && new Date(row.trialEnd) > this.now()) return 'trial';
    return 'free';
  }

  /** Full entitlement snapshot for the org (drives the billing UI + gates). */
  entitlement(orgId) {
    assertOrg(orgId);
    const tier = this.resolveTier(orgId);
    const policy = TIER_POLICY[tier];
    const row = this.billingRepo.getByOrg(orgId);
    const used = this.usageRepo.count(orgId, GRILL_USAGE_METRIC, periodFor(this.now()));
    return {
      orgId,
      tier,
      label: policy.label,
      limits: {
        grillSessionsPerMonth: policy.grillSessionsPerMonth,
        exports: policy.exports,
        unlimitedGrill: policy.unlimitedGrill,
        preview: policy.preview,
      },
      usage: { grillSessionsThisMonth: used },
      billing: {
        plan: row?.plan ?? 'free',
        status: row?.status ?? 'none',
        trialEnd: row?.trialEnd ?? null,
        currentPeriodEnd: row?.currentPeriodEnd ?? null,
      },
    };
  }

  /** Preview mode for the simulate endpoint: free = mocked, paid = simulated. */
  previewMode(orgId) {
    return TIER_POLICY[this.resolveTier(orgId)].preview;
  }

  /**
   * Gate + counter for Grill session kickoff. Free tier is capped at
   * `grillSessionsPerMonth` per calendar month; the counter increments only
   * after the gate passes, so a blocked org never consumes quota.
   * @returns {object} the updated entitlement
   */
  assertGrillQuota(orgId) {
    assertOrg(orgId);
    const tier = this.resolveTier(orgId);
    const policy = TIER_POLICY[tier];
    const period = periodFor(this.now());
    if (policy.grillSessionsPerMonth != null) {
      const used = this.usageRepo.count(orgId, GRILL_USAGE_METRIC, period);
      if (used >= policy.grillSessionsPerMonth) {
        throw new AppError(
          'QUOTA_EXCEEDED',
          `Free plan limit reached: ${policy.grillSessionsPerMonth} Grill sessions per month. Upgrade to Team for unlimited Grill loops and repository export.`,
          402,
          {
            tier,
            limit: policy.grillSessionsPerMonth,
            used,
            period,
            requiredTier: 'team',
          },
        );
      }
    }
    this.usageRepo.increment(orgId, GRILL_USAGE_METRIC, period, 1);
    return this.entitlement(orgId);
  }

  /** Gate for repository export + unlimited loops: Team subscription or trial. */
  assertExportAllowed(orgId) {
    assertOrg(orgId);
    const tier = this.resolveTier(orgId);
    if (!TIER_POLICY[tier].exports) {
      throw new AppError(
        'PAYMENT_REQUIRED',
        'Repository export and unlimited Grill loops require the Team plan ($99/mo) or an active trial.',
        402,
        { tier, requiredTier: 'team' },
      );
    }
    this.usageRepo.increment(orgId, EXPORT_USAGE_METRIC, periodFor(this.now()), 1);
    return this.entitlement(orgId);
  }
}
