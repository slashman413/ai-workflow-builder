/**
 * tiers.js — the billing plan catalogue (pure data, Increment 4).
 *
 * One paid plan today: the Team tier at $99/month (9900 minor units, USD)
 * with a 14-day free trial. Amounts are integers in minor units with an ISO
 * 4217 currency — never floats (rule: store money as integers).
 *
 * The Stripe Price id is injected from the environment so the deployment
 * owns price lifecycle (test mode vs live mode); the fallback is a clearly
 * labelled placeholder that fails the checkout fast if an operator deploys
 * without configuring it.
 */

export const TIERS = Object.freeze({
  free: {
    id: 'free',
    name: 'Free',
    amountMinor: 0,
    currency: 'usd',
    interval: null,
    trialDays: 0,
  },
  team: {
    id: 'team',
    name: 'Team',
    amountMinor: 9900, // $99.00 — integer minor units, never a float
    currency: 'usd',
    interval: 'month',
    trialDays: 14, // the 14-day trial from the PRD
    priceIdEnv: 'STRIPE_TEAM_PRICE_ID',
  },
});

/**
 * Resolve a tier's Stripe Price id.
 * @param {string} tierId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePriceId(tierId, env = process.env) {
  const tier = TIERS[tierId];
  if (!tier) throw new Error(`Unknown tier "${tierId}"`);
  if (tierId === 'free') return null;
  const priceId = env[tier.priceIdEnv];
  if (!priceId) {
    throw new Error(`Missing ${tier.priceIdEnv} — set the Stripe Price id for the ${tier.name} tier (test mode: use a price_xxx from the Stripe dashboard).`);
  }
  return priceId;
}

/**
 * Map a Stripe subscription status onto the app's subscription status
 * machine. Unknown statuses fail closed to 'none' (never guess).
 *
 * Stripe status → app status:
 *   trialing        → trialing
 *   active          → active
 *   past_due        → past_due
 *   incomplete      → incomplete
 *   incomplete_expired → canceled (the user never finished 3DS)
 *   canceled        → canceled
 *   unpaid          → past_due (dunning window is still open)
 */
export function mapSubscriptionStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'incomplete':
      return 'incomplete';
    case 'incomplete_expired':
    case 'canceled':
      return 'canceled';
    default:
      return 'none';
  }
}

/** Human label for the status machine (drives the billing UI). */
export const STATUS_LABELS = Object.freeze({
  none: 'No subscription',
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment past due',
  incomplete: 'Action required',
  canceled: 'Canceled',
});
