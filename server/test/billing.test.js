/**
 * billing.test.js — the Stripe billing use case (Increment 4).
 *
 * Uses the REAL stripe library for webhook signature generation
 * (generateTestHeaderString works fully offline) with a stub Stripe API
 * client for everything else, so no credentials or network are needed.
 *
 * Coverage:
 *   - tier definitions: $99/mo Team tier, 14-day trial, integer minor units;
 *   - checkout session creation (subscription mode, trial, org metadata);
 *   - webhook idempotency: a replayed event is acked and never re-applied;
 *   - out-of-order safety: handlers re-fetch subscription state;
 *   - the status machine: trialing/active/past_due/canceled/incomplete;
 *   - signature verification rejects forged payloads;
 *   - un-attributable events are acked-but-not-applied;
 *   - billing portal + getBilling shapes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { BillingService } from '../src/application/billingService.js';
import { AppError } from '../src/application/errors.js';
import { TIERS, resolvePriceId, mapSubscriptionStatus, STATUS_LABELS } from '../src/domain/billing/tiers.js';

/** A fake Stripe API surface for the service (no network). */
function fakeStripe() {
  const subscriptions = new Map();
  const sessions = [];
  const portalSessions = [];

  const makeSubscription = (overrides = {}) => ({
    id: 'sub_123',
    customer: 'cus_123',
    status: 'trialing',
    current_period_end: 1780000000,
    trial_end: 1780000000,
    cancel_at_period_end: false,
    metadata: { org_id: 'org-1', plan: 'team' },
    ...overrides,
  });

  subscriptions.set('sub_123', makeSubscription());

  return {
    subscriptions: {
      retrieve: async (id) => {
        if (!subscriptions.has(id)) subscriptions.set(id, makeSubscription({ id }));
        return subscriptions.get(id);
      },
    },
    checkout: {
      sessions: {
        create: async (params) => {
          sessions.push(params);
          return { url: 'https://checkout.stripe.com/c/pay/cs_test_123', id: 'cs_test_123' };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          portalSessions.push(params);
          return { url: 'https://billing.stripe.com/p/session/abc', id: 'bps_1' };
        },
      },
    },
    webhooks: {
      // Real signature generation from the stripe library — offline-safe.
      generateTestHeaderString: (payload, secret) =>
        Stripe.webhooks.generateTestHeaderString({ payload, secret }),
      constructEvent: (payload, header, secret) => Stripe.webhooks.constructEvent(payload, header, secret),
    },
    _subscriptions: subscriptions,
    _sessions: sessions,
    _portalSessions: portalSessions,
  };
}

const WEBHOOK_SECRET = 'whsec_test_secret_123';

function makeBilling({ stripe = fakeStripe(), env = {} } = {}) {
  const repos = createMemoryRepos();
  const service = new BillingService(repos, {
    stripe,
    webhookSecret: WEBHOOK_SECRET,
    env: { STRIPE_TEAM_PRICE_ID: 'price_team_9900', ...env },
  });
  return { service, repos, stripe };
}

/** Build a signed webhook payload+header pair for an event. */
function signedWebhook(stripe, event) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString(payload, WEBHOOK_SECRET);
  return { payload, header };
}

function event(type, object, id = `evt_${Math.random().toString(36).slice(2)}`) {
  return { id, type, data: { object } };
}

test('tier definitions: Team is $99/mo (9900 minor units) with a 14-day trial', () => {
  assert.equal(TIERS.team.amountMinor, 9900);
  assert.equal(TIERS.team.currency, 'usd');
  assert.equal(TIERS.team.interval, 'month');
  assert.equal(TIERS.team.trialDays, 14);
  assert.equal(resolvePriceId('team', { STRIPE_TEAM_PRICE_ID: 'price_x' }), 'price_x');
  assert.throws(() => resolvePriceId('team', {}), /STRIPE_TEAM_PRICE_ID/);
});

test('subscription status machine maps Stripe statuses and fails closed', () => {
  assert.equal(mapSubscriptionStatus('trialing'), 'trialing');
  assert.equal(mapSubscriptionStatus('active'), 'active');
  assert.equal(mapSubscriptionStatus('past_due'), 'past_due');
  assert.equal(mapSubscriptionStatus('unpaid'), 'past_due');
  assert.equal(mapSubscriptionStatus('incomplete'), 'incomplete');
  assert.equal(mapSubscriptionStatus('incomplete_expired'), 'canceled');
  assert.equal(mapSubscriptionStatus('canceled'), 'canceled');
  assert.equal(mapSubscriptionStatus('weird-new-status'), 'none');
  assert.equal(STATUS_LABELS.active, 'Active');
});

test('createCheckoutSession: subscription mode, trial period, org metadata', async () => {
  const { service, stripe } = makeBilling();
  const result = await service.createCheckoutSession('org-1', {
    successUrl: 'https://workflow-builders.com/billing?ok=1',
    cancelUrl: 'https://workflow-builders.com/billing',
  });
  assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
  const params = stripe._sessions[0];
  assert.equal(params.mode, 'subscription');
  assert.equal(params.line_items[0].price, 'price_team_9900');
  assert.equal(params.subscription_data.trial_period_days, 14);
  assert.equal(params.subscription_data.metadata.org_id, 'org-1');
  assert.equal(params.client_reference_id, 'org-1');
  assert.equal(params.metadata.org_id, 'org-1');
});

test('createCheckoutSession fails closed when billing is not configured', async () => {
  const { service } = makeBilling({ stripe: null, env: {} });
  await assert.rejects(
    () => service.createCheckoutSession('org-1', { successUrl: 'u', cancelUrl: 'c' }),
    (e) => e instanceof AppError && e.code === 'BILLING_NOT_CONFIGURED' && e.status === 503,
  );
  assert.equal(service.isConfigured(), false);
});

test('webhook: signature verification rejects forged payloads', async () => {
  const { service } = makeBilling();
  const forged = JSON.stringify(event('customer.subscription.updated', { id: 'sub_1' }));
  await assert.rejects(
    () => service.handleWebhookRequest(forged, 't=1,v1=deadbeef'),
    (e) => e instanceof AppError && e.code === 'INVALID_SIGNATURE' && e.status === 400,
  );
  // Nothing was recorded.
  assert.equal(service.billingRepo.listEvents('org-1').length, 0);
});

test('webhook: checkout.session.completed provisions the tenant subscription', async () => {
  const { service, stripe, repos } = makeBilling();
  const sub = stripe._subscriptions.get('sub_123');
  sub.status = 'trialing';
  const { payload, header } = signedWebhook(stripe, event('checkout.session.completed', {
    id: 'cs_1',
    subscription: 'sub_123',
    customer: 'cus_123',
    metadata: { org_id: 'org-1', plan: 'team' },
  }));

  const result = await service.handleWebhookRequest(payload, header);
  assert.equal(result.processed, true);
  assert.equal(result.orgId, 'org-1');

  const billing = repos.billing.getByOrg('org-1');
  assert.equal(billing.status, 'trialing');
  assert.equal(billing.plan, 'team');
  assert.equal(billing.stripeSubscriptionId, 'sub_123');
  assert.equal(billing.stripeCustomerId, 'cus_123');
  assert.ok(billing.trialEnd, 'trial end must be recorded');
});

test('webhook idempotency: a replayed event is acked but never re-applied', async () => {
  const { service, stripe, repos } = makeBilling();
  const evt = event('customer.subscription.deleted', {
    id: 'sub_123',
    customer: 'cus_123',
    metadata: { org_id: 'org-1', plan: 'team' },
    current_period_end: 1780000000,
  }, 'evt_replay_1');

  const { payload, header } = signedWebhook(stripe, evt);
  const first = await service.handleWebhookRequest(payload, header);
  assert.equal(first.processed, true);
  assert.equal(repos.billing.getByOrg('org-1').status, 'canceled');

  // Replay the SAME event id → duplicate ack, state unchanged.
  const second = await service.handleWebhookRequest(payload, header);
  assert.equal(second.processed, false);
  assert.equal(second.duplicate, true);
  assert.equal(repos.billing.getByOrg('org-1').status, 'canceled');
  assert.equal(repos.billing.listEvents('org-1').length, 1, 'only one ledger row ever');
});

test('out-of-order safety: subscription.updated re-fetches current state', async () => {
  const { service, stripe, repos } = makeBilling();
  // The subscription is ACTIVE server-side, but a STALE event says canceled.
  stripe._subscriptions.get('sub_123').status = 'active';
  const stale = event('customer.subscription.updated', {
    id: 'sub_123',
    status: 'canceled', // stale payload — must NOT be trusted
    metadata: { org_id: 'org-1' },
  });
  const { payload, header } = signedWebhook(stripe, stale);
  const result = await service.handleWebhookRequest(payload, header);
  assert.equal(result.processed, true);
  assert.equal(repos.billing.getByOrg('org-1').status, 'active', 'current state wins over stale event');
});

test('invoice.payment_failed drives the subscription to past_due', async () => {
  const { service, stripe, repos } = makeBilling();
  stripe._subscriptions.get('sub_123').status = 'past_due';
  const evt = event('invoice.payment_failed', {
    id: 'in_1',
    subscription: 'sub_123',
    metadata: { org_id: 'org-1' },
    subscription_details: { metadata: { org_id: 'org-1' } },
  });
  const { payload, header } = signedWebhook(stripe, evt);
  await service.handleWebhookRequest(payload, header);
  assert.equal(repos.billing.getByOrg('org-1').status, 'past_due');
});

test('un-attributable events are acked but not applied', async () => {
  const { service, stripe, repos } = makeBilling();
  const evt = event('customer.subscription.updated', { id: 'sub_orphan' }); // no org metadata
  const { payload, header } = signedWebhook(stripe, evt);
  const result = await service.handleWebhookRequest(payload, header);
  assert.equal(result.processed, false);
  assert.equal(result.unattributable, true);
  assert.equal(repos.billing.getByOrg('org-1'), null, 'no org row was touched');
});

test('inert events (trial_will_end, disputes) are logged and ignored', async () => {
  const { service, stripe } = makeBilling();
  const evt = event('charge.dispute.created', { id: 'dp_1', amount: 9900 });
  const { payload, header } = signedWebhook(stripe, evt);
  const result = await service.handleWebhookRequest(payload, header);
  assert.equal(result.ignored, true);
  assert.equal(result.processed, false);
});

test('getBilling exposes the status machine shape and never Stripe internals', async () => {
  const { service, repos } = makeBilling();
  const before = service.getBilling('org-1');
  assert.equal(before.status, 'none');
  assert.equal(before.plan, 'free');
  assert.equal(before.statusLabel, 'No subscription');

  repos.billing.upsert('org-1', { status: 'past_due', plan: 'team', trialEnd: '2026-08-15T00:00:00.000Z' });
  const after = service.getBilling('org-1');
  assert.equal(after.status, 'past_due');
  assert.equal(after.statusLabel, 'Payment past due');
  assert.equal(after.trialEnd, '2026-08-15T00:00:00.000Z');
});

test('billing portal requires an existing customer', async () => {
  const { service, repos } = makeBilling();
  await assert.rejects(
    () => service.createPortalLink('org-1'),
    (e) => e.code === 'NO_CUSTOMER' && e.status === 409,
  );
  repos.billing.upsert('org-1', { stripeCustomerId: 'cus_123', status: 'active' });
  const { url } = await service.createPortalLink('org-1', { returnUrl: 'https://workflow-builders.com/billing' });
  assert.match(url, /billing\.stripe\.com/);
});

test('billing is tenant-scoped: org rows never leak across tenants', async () => {
  const { service, repos } = makeBilling();
  repos.billing.upsert('org-a', { status: 'active', plan: 'team' });
  repos.billing.upsert('org-b', { status: 'trialing' });
  assert.equal(service.getBilling('org-a').status, 'active');
  assert.equal(service.getBilling('org-b').status, 'trialing');
  assert.equal(service.getBilling('org-c').status, 'none');
});
