/**
 * entitlement.test.js — tier resolution + quota enforcement (Increment 4).
 *
 * The product rules under test:
 *   - Free tier: ≤ 10 Grill sessions per calendar month, mocked previews
 *     ('mock'), NO repository export.
 *   - Trial/Team: unlimited Grill loops, exports allowed, 'simulated'
 *     previews.
 *   - Enforcement lives in the service layer (EntitlementService) so direct
 *     API calls cannot bypass it; usage counters are org-scoped so one
 *     tenant can never consume another tenant's quota.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { EntitlementService, periodFor, GRILL_USAGE_METRIC, EXPORT_USAGE_METRIC } from '../src/application/entitlementService.js';
import { AppError } from '../src/application/errors.js';

function makeService({ now = () => new Date('2026-08-15T00:00:00Z') } = {}) {
  const repos = createMemoryRepos();
  const service = new EntitlementService(repos, { now });
  return { repos, service, now };
}

/** Simulate an active Team subscription (as the webhook would upsert it). */
function activateTeam(repos, orgId, { status = 'active', trialEnd = null } = {}) {
  repos.billing.upsert(orgId, {
    stripeCustomerId: 'cus_test_1',
    stripeSubscriptionId: 'sub_test_1',
    plan: 'team',
    status,
    currentPeriodEnd: '2026-09-01T00:00:00Z',
    trialEnd,
  });
}

test('fresh org resolves to the free tier with a 10-session monthly cap', () => {
  const { service } = makeService();
  const e = service.entitlement('org-a');
  assert.equal(e.tier, 'free');
  assert.equal(e.limits.grillSessionsPerMonth, 10);
  assert.equal(e.limits.exports, false);
  assert.equal(e.limits.unlimitedGrill, false);
  assert.equal(e.limits.preview, 'mock');
  assert.equal(e.usage.grillSessionsThisMonth, 0);
});

test('free tier: the 11th grill session in a month is rejected with 402', () => {
  const { service } = makeService();
  for (let i = 1; i <= 10; i += 1) {
    const e = service.assertGrillQuota('org-a');
    assert.equal(e.usage.grillSessionsThisMonth, i, `session ${i} must be admitted`);
  }
  assert.throws(() => service.assertGrillQuota('org-a'), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'QUOTA_EXCEEDED');
    assert.equal(err.status, 402);
    assert.equal(err.details.limit, 10);
    assert.equal(err.details.used, 10);
    return true;
  });
});

test('free tier: quota resets at the month boundary', () => {
  let current = new Date('2026-08-31T23:59:00Z');
  const { service } = makeService({ now: () => current });
  for (let i = 1; i <= 10; i += 1) service.assertGrillQuota('org-a');
  assert.throws(() => service.assertGrillQuota('org-a'), (err) => err instanceof AppError && err.code === 'QUOTA_EXCEEDED');
  // Roll into September — the counter window changes and the cap resets.
  current = new Date('2026-09-01T00:00:00Z');
  assert.equal(service.assertGrillQuota('org-a').usage.grillSessionsThisMonth, 1);
});

test('free tier: blocked sessions never consume quota (gate runs before increment)', () => {
  const { repos, service } = makeService();
  for (let i = 1; i <= 10; i += 1) service.assertGrillQuota('org-a');
  assert.throws(() => service.assertGrillQuota('org-a'));
  assert.equal(repos.usage.count('org-a', GRILL_USAGE_METRIC, periodFor()), 10);
});

test('free tier: repository export is refused with 402 PAYMENT_REQUIRED', () => {
  const { service } = makeService();
  assert.throws(() => service.assertExportAllowed('org-a'), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'PAYMENT_REQUIRED');
    assert.equal(err.status, 402);
    assert.equal(err.details.tier, 'free');
    return true;
  });
});

test('active Team subscription: unlimited grill, exports allowed, simulated preview', () => {
  const { repos, service } = makeService();
  activateTeam(repos, 'org-a');
  const e = service.entitlement('org-a');
  assert.equal(e.tier, 'team');
  assert.equal(e.limits.grillSessionsPerMonth, null);
  assert.equal(e.limits.exports, true);
  assert.equal(e.limits.preview, 'simulated');

  // No cap: 25 sessions in a row all pass.
  for (let i = 1; i <= 25; i += 1) service.assertGrillQuota('org-a');
  assert.equal(service.assertExportAllowed('org-a').tier, 'team');
});

test('trialing subscription maps to the trial tier with full access', () => {
  const { repos, service } = makeService();
  activateTeam(repos, 'org-a', { status: 'trialing', trialEnd: '2026-08-25T00:00:00Z' });
  const e = service.entitlement('org-a');
  assert.equal(e.tier, 'trial');
  assert.equal(e.limits.exports, true);
  assert.equal(e.limits.unlimitedGrill, true);
  assert.equal(service.previewMode('org-a'), 'simulated');
});

test('past_due keeps Team access during the dunning grace period', () => {
  const { repos, service } = makeService();
  activateTeam(repos, 'org-a', { status: 'past_due' });
  assert.equal(service.resolveTier('org-a'), 'team');
});

test('canceled subscription falls back to free (no trial window left)', () => {
  const { repos, service } = makeService();
  activateTeam(repos, 'org-a', { status: 'canceled', trialEnd: '2026-08-01T00:00:00Z' });
  assert.equal(service.resolveTier('org-a'), 'free');
  assert.throws(() => service.assertExportAllowed('org-a'), (err) => err instanceof AppError && err.code === 'PAYMENT_REQUIRED');
});

test('canceled-but-within-trial-window still resolves to trial', () => {
  const { repos, service } = makeService();
  activateTeam(repos, 'org-a', { status: 'canceled', trialEnd: '2026-08-30T00:00:00Z' });
  assert.equal(service.resolveTier('org-a'), 'trial');
});

test('usage counters are org-scoped: one tenant can never burn another quota', () => {
  const { service } = makeService();
  for (let i = 1; i <= 10; i += 1) service.assertGrillQuota('org-a');
  assert.throws(() => service.assertGrillQuota('org-a'));
  // org-b is untouched and still has all 10 sessions.
  for (let i = 1; i <= 10; i += 1) service.assertGrillQuota('org-b');
  assert.equal(service.entitlement('org-b').usage.grillSessionsThisMonth, 10);
});

test('periodFor produces the YYYY-MM window key', () => {
  assert.equal(periodFor(new Date('2026-08-31T23:59:59Z')), '2026-08');
  assert.equal(periodFor(new Date('2026-09-01T00:00:00Z')), '2026-09');
  assert.equal(periodFor(new Date('2026-12-25T12:00:00Z')), '2026-12');
});

test('export usage is recorded for Team tiers (reconciliation of the gate)', () => {
  const { repos, service } = makeService();
  activateTeam(repos, 'org-a');
  service.assertExportAllowed('org-a');
  service.assertExportAllowed('org-a');
  assert.equal(repos.usage.count('org-a', EXPORT_USAGE_METRIC, periodFor()), 2);
});
