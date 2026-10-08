'use strict';

const { createTransactionContext } = require('../../../src/billing/kernel/transactionContext');
const { createSubscriptionLifecycleService } = require('../../../src/billing/modules/subscriptions');
const { DOMAIN_ERROR_CODES } = require('../../../src/billing/contracts/errors');

const TERMS = {
  schemaVersion: 1,
  currency: 'INR',
  billingInterval: { unit: 'month', count: 1 },
  subscriptionPrice: { asset: 'INR', units: '1000000', scale: 6 },
  structure: { mode: 'same_industry', includedWorkspaces: 1, includedDistinctIndustries: 1, maxWorkspaces: 10, maxDistinctIndustries: 1, orgAdminWorkspaceIndustry: 'primary_only' },
  workspaceFees: { additionalWorkspace: { asset: 'INR', units: '10000', scale: 6 }, additionalDistinctIndustry: { asset: 'INR', units: '50000', scale: 6 } },
  includedCredits: { asset: 'CREDITS', units: '1000', scale: 0 },
  taxes: [],
  postpaid: { eligible: true, workspaceModes: ['limited'], organizationExposureLimit: null },
  serviceAfterExpiry: { mode: 'continue_postpaid', graceSeconds: 0 },
};

function fixture({ purchaseAt = '2026-10-20T12:00:00.000Z', account = {} } = {}) {
  let sequence = 0;
  const periods = new Map();
  let funded = false;
  let approved = true;
  const tx = createTransactionContext({ query: async () => [] }, { orgId: 'org-a', operationId: 'op', billingAccountVersion: 1 });
  const unitOfWork = { runFinancial: async ({ callback }) => callback(tx) };
  const periodRepository = {
    periods,
    async getBillingAccount() { return { orgId: 'org-a', timezone: 'Asia/Kolkata', fallbackMode: 'postpaid', postpaidEligible: true, ...account }; },
    async getApprovedSubscriptionPurchase(_tx, { paymentRequestId }) {
      if (!approved) throw Object.assign(new Error('no approved request'), { code: DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED });
      return { paymentRequestId, quoteId: 'quote-a', quoteType: 'renewal', purchaseAt,
        termsSnapshot: { schemaVersion: 1, plan: { id: 'plan-a', version: 2, terms: TERMS } }, effectiveTerms: TERMS };
    },
    async linkApprovedSubscriptionPayment(_tx, { periodId }) { funded = true; return { periodId, funded: true }; },
    async getCurrentPeriodForUpdate(_tx, { at }) {
      return [...periods.values()].find((period) => ['active', 'scheduled'].includes(period.status)
        && Date.parse(period.startAt) <= Date.parse(at) && Date.parse(period.endAt) > Date.parse(at)) || null;
    },
    async getPeriod(_tx, { periodId }) { return periods.get(periodId) || null; },
    async listPeriods(_tx, { from, to }) {
      return [...periods.values()].filter((period) => Date.parse(period.endAt) > Date.parse(from) && Date.parse(period.startAt) < Date.parse(to));
    },
    async insertScheduledPeriod(_tx, record) {
      const start = Date.parse(record.startAt); const end = Date.parse(record.endAt);
      if ([...periods.values()].some((item) => item.status !== 'cancelled' && Date.parse(item.startAt) < end && Date.parse(item.endAt) > start)) {
        throw Object.assign(new Error('overlap'), { code: DOMAIN_ERROR_CODES.PERIOD_INVALID });
      }
      const saved = { ...record };
      periods.set(saved.id, saved);
      return saved;
    },
    async assertPeriodFunded() {
      if (!funded) throw Object.assign(new Error('unfunded'), { code: DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED });
      return true;
    },
    async transitionPeriod(_tx, { orgId, periodId, expectedStatus, status, fields, fundingProof, allowPostpaidActivation }) {
      const period = periods.get(periodId);
      if (!period || period.orgId !== orgId || period.status !== expectedStatus) throw new Error('status conflict');
      if (status === 'active' && period.periodKind === 'subscription') {
        if (!fundingProof?.paymentRequestId || !funded) throw Object.assign(new Error('unfunded'), { code: DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED });
      }
      if (status === 'active' && period.periodKind === 'postpaid' && !allowPostpaidActivation) throw new Error('postpaid not authorized');
      const updated = { ...period, ...fields, status };
      periods.set(periodId, updated);
      return updated;
    },
    setFunded(value) { funded = value; },
    setApproved(value) { approved = value; },
  };
  const service = createSubscriptionLifecycleService({
    unitOfWork,
    periodRepository,
    idSource: { newId: () => `period-${++sequence}` },
    clock: { now: () => '2026-10-20T12:00:00.000Z' },
  });
  const baseCommand = { orgId: 'org-a', operationId: 'op-1', requestFingerprint: `sha256:${'a'.repeat(64)}` };
  return { service, periodRepository, baseCommand };
}

describe('subscription lifecycle', () => {
  test('public module exports lifecycle, period math, and MySQL repository factories', () => {
    const subscriptions = require('../../../src/billing/modules/subscriptions');
    expect(typeof subscriptions.createSubscriptionLifecycleService).toBe('function');
    expect(typeof subscriptions.previewSubscriptionPeriod).toBe('function');
    expect(typeof subscriptions.createMysqlPeriodRepository).toBe('function');
  });

  test('schedules early renewal after the current cycle using its preserved anchor', async () => {
    const { service, periodRepository, baseCommand } = fixture();
    periodRepository.periods.set('current', {
      id: 'current', orgId: 'org-a', periodKind: 'subscription', status: 'active',
      startAt: '2026-10-01T00:00:00.000Z', endAt: '2026-11-01T00:00:00.000Z', anchorAt: '2026-10-01T00:00:00.000Z',
    });
    const period = await service.schedulePaidRenewal({ ...baseCommand, paymentRequestId: 'payment-a' });
    expect(period.startAt).toBe('2026-11-01T00:00:00.000Z');
    expect(period.endAt).toBe('2026-12-01T00:00:00.000Z');
    expect(period.anchorAt).toBe('2026-10-01T00:00:00.000Z');
    expect(period.termsSnapshot.quoteId).toBe('quote-a');
    expect(period.renewalPreview.lateRenewal).toBe(false);
  });

  test('reports a late renewal preview without resetting an active cycle', async () => {
    const { service, periodRepository, baseCommand } = fixture({ purchaseAt: '2026-11-05T00:00:00.000Z' });
    periodRepository.periods.set('previous', {
      id: 'previous', orgId: 'org-a', periodKind: 'subscription', status: 'ended',
      startAt: '2026-09-01T00:00:00.000Z', endAt: '2026-10-01T00:00:00.000Z', anchorAt: '2026-09-01T00:00:00.000Z',
    });
    const period = await service.schedulePaidRenewal({ ...baseCommand, paymentRequestId: 'payment-a' });
    expect(period.startAt).toBe('2026-11-05T00:00:00.000Z');
    expect(period.renewalPreview.lateRenewal).toBe(true);
  });

  test('requires stored fulfillment before a scheduled subscription can activate', async () => {
    const { service, periodRepository, baseCommand } = fixture();
    const period = await service.schedulePaidRenewal({ ...baseCommand, paymentRequestId: 'payment-a' });
    periodRepository.setFunded(false);
    await expect(service.activateScheduledPeriod({ ...baseCommand, operationId: 'op-2', periodId: period.id, paymentRequestId: 'payment-a' }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED });
    periodRepository.setFunded(true);
    await expect(service.activateScheduledPeriod({ ...baseCommand, operationId: 'op-3', periodId: period.id, paymentRequestId: 'payment-a' }))
      .resolves.toMatchObject({ status: 'active' });
  });

  test('read methods do not materialize or roll periods', async () => {
    const { service, periodRepository } = fixture();
    const tx = createTransactionContext({ query: async () => [] }, { orgId: 'org-a', operationId: 'read', billingAccountVersion: 1 });
    expect(await service.listPeriods(tx, { orgId: 'org-a', from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' })).toEqual([]);
    expect(await service.getPeriod(tx, { orgId: 'org-a', periodId: 'missing' })).toBeNull();
    expect(periodRepository.periods.size).toBe(0);
  });

  test('cancels scheduled renewals while preserving the paid active cycle', async () => {
    const { service, periodRepository, baseCommand } = fixture();
    periodRepository.periods.set('current', {
      id: 'current', orgId: 'org-a', periodKind: 'subscription', status: 'active',
      startAt: '2026-10-01T00:00:00.000Z', endAt: '2026-11-01T00:00:00.000Z', anchorAt: '2026-10-01T00:00:00.000Z',
    });
    periodRepository.periods.set('renewal', {
      id: 'renewal', orgId: 'org-a', periodKind: 'subscription', status: 'scheduled',
      startAt: '2026-11-01T00:00:00.000Z', endAt: '2026-12-01T00:00:00.000Z', anchorAt: '2026-10-01T00:00:00.000Z',
    });
    const result = await service.cancelSubscriptionRenewal({ ...baseCommand, currentPeriodId: 'current' });
    expect(result.currentPeriod.status).toBe('active');
    expect(result.cancelledPeriods.map((period) => period.id)).toEqual(['renewal']);
    expect(periodRepository.periods.get('renewal').status).toBe('cancelled');
  });

  test('uses the persisted postpaid anchor and cadence for subsequent periods', async () => {
    const { service, periodRepository, baseCommand } = fixture();
    const first = await service.schedulePostpaidPeriod({
      ...baseCommand, anchorAt: '2026-01-15T00:00:00.000Z', intervalUnit: 'month', intervalCount: 1,
      timeZone: 'UTC', now: '2026-03-20T00:00:00.000Z',
    });
    expect(first.startAt).toBe('2026-03-15T00:00:00.000Z');
    expect(first.endAt).toBe('2026-04-15T00:00:00.000Z');
    const second = await service.schedulePostpaidPeriod({
      ...baseCommand, operationId: 'op-2', timeZone: 'UTC', now: '2026-04-20T00:00:00.000Z',
    });
    expect(second.startAt).toBe('2026-04-15T00:00:00.000Z');
    expect(second.endAt).toBe('2026-05-15T00:00:00.000Z');
    expect(second.anchorAt).toBe('2026-01-15T00:00:00.000Z');
  });

  test('does not schedule a period from an unapproved subscription payment', async () => {
    const { service, periodRepository, baseCommand } = fixture();
    periodRepository.setApproved(false);
    await expect(service.schedulePaidRenewal({ ...baseCommand, paymentRequestId: 'payment-a' }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED });
    expect(periodRepository.periods.size).toBe(0);
  });
});
