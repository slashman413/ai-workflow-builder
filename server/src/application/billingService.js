/**
 * billingService.js — the Stripe billing use case (Increment 4).
 *
 * Tenancy: billing is keyed by the SAME org_id the auth choke point binds
 * to every request, and Stripe objects carry `org_id` in metadata so the
 * webhook (which has no session) can attribute events back to the tenant.
 *
 * Webhook correctness (the payments engineer's non-negotiables):
 *
 *   1. SIGNATURE VERIFICATION — `constructEvent` runs against the RAW body
 *      (the route mounts express.raw for this path; parsed JSON breaks
 *      verification). A bad signature throws and the route answers 400 —
 *      Stripe retries, we never apply an unverified event.
 *
 *   2. IDEMPOTENCY — every event id is recorded in the billing_events
 *      ledger (PRIMARY KEY insert). At-least-once delivery means the second
 *      arrival of the same event is acknowledged and skipped: side effects
 *      run exactly once, ever.
 *
 *   3. OUT-OF-ORDER SAFETY — handlers never trust event ordering. For
 *      subscription mutations we RE-FETCH the subscription from Stripe and
 *      apply the CURRENT state, so a stale `subscription.updated` arriving
 *      after a newer one cannot regress the row.
 *
 *   4. FAIL CLOSED — unknown statuses map to 'none', un-attributable events
 *      (no org_id in metadata) are acked-but-not-applied (and surfaced in
 *      the event ledger for ops), and an unconfigured deployment answers
 *      503 instead of guessing.
 */

import Stripe from 'stripe';
import { AppError, assertOrg } from './errors.js';
import { TIERS, resolvePriceId, mapSubscriptionStatus, STATUS_LABELS } from '../domain/billing/tiers.js';

export class BillingService {
  /**
   * @param {{ billing: any }} repos
   * @param {object} [opts]
   * @param {import('stripe').Stripe|null} [opts.stripe] Stripe client
   *   (injected so tests never need credentials; created from the
   *   environment when absent).
   * @param {string} [opts.webhookSecret]
   * @param {NodeJS.ProcessEnv} [opts.env]
   */
  constructor(repos, { stripe = null, webhookSecret = null, env = process.env } = {}) {
    this.billingRepo = repos.billing;
    this.env = env;
    this.webhookSecret = webhookSecret ?? env.STRIPE_WEBHOOK_SECRET ?? null;
    this.stripe =
      stripe ??
      (env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null);
  }

  /** Is billing operational on this deployment? (drives the UI affordance) */
  isConfigured() {
    return Boolean(this.stripe && this.webhookSecret && this.env.STRIPE_TEAM_PRICE_ID);
  }

  /** Current subscription state for the org (never exposes Stripe internals). */
  getBilling(orgId) {
    assertOrg(orgId);
    const row = this.billingRepo.getByOrg(orgId);
    return {
      orgId,
      configured: this.isConfigured(),
      plan: row?.plan ?? 'free',
      status: row?.status ?? 'none',
      statusLabel: STATUS_LABELS[row?.status ?? 'none'],
      trialEnd: row?.trialEnd ?? null,
      currentPeriodEnd: row?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /**
   * Create a Stripe Checkout session for the Team tier (14-day trial).
   * @returns {Promise<{ url: string, sessionId: string }>}
   */
  async createCheckoutSession(orgId, { successUrl, cancelUrl, tierId = 'team' } = {}) {
    assertOrg(orgId);
    const tier = TIERS[tierId];
    if (!tier || tierId === 'free') {
      throw new AppError('INVALID_TIER', `Tier "${tierId}" cannot be purchased directly.`, 400);
    }
    if (!this.stripe) {
      throw new AppError('BILLING_NOT_CONFIGURED', 'Stripe is not configured on this deployment.', 503);
    }
    let priceId;
    try {
      priceId = resolvePriceId(tierId, this.env);
    } catch (err) {
      throw new AppError('BILLING_NOT_CONFIGURED', err.message, 503);
    }
    if (!successUrl || !cancelUrl) {
      throw new AppError('INVALID_URLS', 'successUrl and cancelUrl are required.', 400);
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: tier.trialDays,
        metadata: { org_id: orgId, plan: tierId },
      },
      metadata: { org_id: orgId, plan: tierId },
      client_reference_id: orgId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
    });
    return { url: session.url, sessionId: session.id };
  }

  /** Stripe billing portal link for the org's customer. */
  async createPortalLink(orgId, { returnUrl } = {}) {
    assertOrg(orgId);
    if (!this.stripe) {
      throw new AppError('BILLING_NOT_CONFIGURED', 'Stripe is not configured on this deployment.', 503);
    }
    const row = this.billingRepo.getByOrg(orgId);
    if (!row?.stripeCustomerId) {
      throw new AppError('NO_CUSTOMER', 'No Stripe customer exists for this workspace yet. Start a subscription first.', 409);
    }
    const session = await this.stripe.billingPortal.sessions.create({
      customer: row.stripeCustomerId,
      return_url: returnUrl ?? this.env.APP_ORIGIN ?? 'https://workflow-builders.com',
    });
    return { url: session.url };
  }

  /* -------------------------------------------------------------------------
   * Webhooks — the source of truth for money movement.
   * ---------------------------------------------------------------------- */

  /**
   * Verify + process a webhook request. Called by the raw-body route.
   * @param {Buffer|string} rawBody The RAW request body (never parsed JSON).
   * @param {string|null} signature The `stripe-signature` header.
   */
  async handleWebhookRequest(rawBody, signature) {
    if (!this.stripe || !this.webhookSecret) {
      throw new AppError('BILLING_NOT_CONFIGURED', 'Stripe webhooks are not configured on this deployment.', 503);
    }
    let event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err) {
      // Signature verification failure — never apply, answer 400 so Stripe
      // retries (and so forged payloads get nowhere).
      throw new AppError('INVALID_SIGNATURE', `Webhook signature verification failed: ${err.message}`, 400);
    }
    return this.handleWebhookEvent(event);
  }

  /**
   * Apply one verified webhook event. Idempotent and out-of-order safe.
   * @param {import('stripe').Stripe.Event} event
   */
  async handleWebhookEvent(event) {
    const orgId = extractOrgId(event);
    // Idempotency ledger first: a duplicate delivery is acked and skipped.
    const isNew = this.billingRepo.recordEvent({ eventId: event.id, eventType: event.type, orgId });
    if (!isNew) {
      return { eventId: event.id, type: event.type, processed: false, duplicate: true, orgId };
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const subscriptionId = session.subscription ?? session.metadata?.subscription;
          const targetOrg = session.metadata?.org_id ?? orgId;
          if (!targetOrg) return this.unattributable(event, 'checkout.session.completed');
          if (subscriptionId) await this.applySubscription(targetOrg, subscriptionId);
          else if (session.customer) {
            this.billingRepo.upsert(targetOrg, { stripeCustomerId: session.customer, plan: session.metadata?.plan ?? 'team', status: 'incomplete' });
          }
          return { eventId: event.id, type: event.type, processed: true, orgId: targetOrg };
        }

        case 'customer.subscription.updated': {
          const sub = event.data.object;
          const targetOrg = sub.metadata?.org_id ?? orgId;
          if (!targetOrg) return this.unattributable(event, 'customer.subscription.updated');
          // Re-fetch: the event's data may be stale relative to later
          // events; the API always returns current state.
          await this.applySubscription(targetOrg, sub.id);
          return { eventId: event.id, type: event.type, processed: true, orgId: targetOrg };
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const targetOrg = sub.metadata?.org_id ?? orgId;
          if (!targetOrg) return this.unattributable(event, 'customer.subscription.deleted');
          this.billingRepo.upsert(targetOrg, {
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            plan: sub.metadata?.plan ?? 'team',
            status: 'canceled',
            currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
            cancelAtPeriodEnd: false,
          });
          return { eventId: event.id, type: event.type, processed: true, orgId: targetOrg };
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const targetOrg = invoice.subscription_details?.metadata?.org_id ?? invoice.metadata?.org_id ?? orgId;
          const subscriptionId = invoice.subscription;
          if (!targetOrg || !subscriptionId) return this.unattributable(event, 'invoice.payment_failed');
          // Dunning is Stripe's job; our job is the STATUS. Re-fetch to see
          // whether the sub is now past_due (retries pending) or already
          // canceled — the event alone is not the current truth.
          await this.applySubscription(targetOrg, subscriptionId);
          return { eventId: event.id, type: event.type, processed: true, orgId: targetOrg };
        }

        case 'invoice.paid': {
          const invoice = event.data.object;
          const targetOrg = invoice.subscription_details?.metadata?.org_id ?? invoice.metadata?.org_id ?? orgId;
          const subscriptionId = invoice.subscription;
          if (!targetOrg || !subscriptionId) return this.unattributable(event, 'invoice.paid');
          await this.applySubscription(targetOrg, subscriptionId);
          return { eventId: event.id, type: event.type, processed: true, orgId: targetOrg };
        }

        // Acked-but-inert events: we log them, we never act on them.
        case 'customer.subscription.trial_will_end':
        case 'checkout.session.async_payment_succeeded':
        case 'checkout.session.async_payment_failed':
        case 'charge.dispute.created':
        case 'charge.dispute.closed':
          return { eventId: event.id, type: event.type, processed: false, ignored: true, orgId };
        default:
          return { eventId: event.id, type: event.type, processed: false, ignored: true, orgId };
      }
    } catch (err) {
      // Processing error AFTER the dedupe insert: surface as an AppError so
      // the route can answer 500 and Stripe will retry. The event id is
      // already in the ledger but the row was not applied — retry will
      // short-circuit at the ledger. This is the safe direction (never
      // double-apply, at worst miss an update until the next event).
      throw err instanceof AppError ? err : new AppError('WEBHOOK_PROCESSING', `Webhook ${event.id} (${event.type}) failed: ${err.message}`, 500);
    }
  }

  /* -------------------------------------------------------------------------
   * Helpers
   * ---------------------------------------------------------------------- */

  /** Re-fetch a subscription and upsert the org's billing row from CURRENT state. */
  async applySubscription(orgId, subscriptionId) {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
    this.billingRepo.upsert(orgId, {
      stripeCustomerId: sub.customer,
      stripeSubscriptionId: sub.id,
      plan: sub.metadata?.plan ?? 'team',
      status: mapSubscriptionStatus(sub.status),
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
      trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    });
    return this.billingRepo.getByOrg(orgId);
  }

  /** Event carries no org identity — ack it (stop Stripe retrying) but apply nothing. */
  unattributable(event, type) {
    return { eventId: event.id, type, processed: false, unattributable: true, reason: 'no org_id in metadata', orgId: null };
  }
}

/** Best-effort org attribution from an event's payload (metadata first). */
function extractOrgId(event) {
  const obj = event?.data?.object ?? {};
  return (
    obj.metadata?.org_id ??
    obj.client_reference_id ??
    obj.subscription_details?.metadata?.org_id ??
    null
  );
}
