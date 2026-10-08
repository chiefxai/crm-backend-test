'use strict';

const { createMysqlPeriodRepository } = require('../../../src/billing/modules/subscriptions/repositories/mysqlPeriodRepository');
const { createTransactionContext } = require('../../../src/billing/kernel/transactionContext');
const { DOMAIN_ERROR_CODES } = require('../../../src/billing/contracts/errors');

function transaction(metadata = { orgId: 'org-1' }, handler = async () => []) {
  const calls = [];
  const tx = createTransactionContext({
    async query(sql, params) { calls.push({ sql, params }); return handler(sql, params, calls.length); },
  }, metadata);
  return { tx, calls };
}
function dbRow(overrides = {}) {
  return {
    id: 'period-1', org_id: 'org-1', period_kind: 'subscription',
    starts_at: '2026-01-01 00:00:00.000000', ends_at: '2026-02-01 00:00:00.000000',
    anchor_at: '2026-01-31 00:00:00.000000', terms_version: 4, status: 'scheduled',
    terms_snapshot_json: JSON.stringify({ schemaVersion: 1, effectiveTerms: { includedCredits: 100 } }),
    activated_at: null, closed_at: null, created_at: '2025-12-20 12:00:00.000000', updated_at: '2025-12-20 12:00:00.000000',
    ...overrides,
  };
}
const period = {
  id: 'period-1', orgId: 'org-1', periodKind: 'subscription',
  startAt: '2026-01-01T00:00:00.000Z', endAt: '2026-02-01T00:00:00.000Z',
  anchorAt: '2026-01-31T00:00:00.000Z', termsVersion: 4, status: 'scheduled',
  termsSnapshot: { schemaVersion: 1, effectiveTerms: { includedCredits: 100 } },
  createdAt: '2025-12-20T12:00:00.000Z', updatedAt: '2025-12-20T12:00:00.000Z',
};

describe('MySQL subscription period repository', () => {
  test('rejects transactions with a different organization scope', async () => {
    const repo = createMysqlPeriodRepository();
    const { tx } = transaction({ orgId: 'org-2' });
    await expect(repo.getPeriod(tx, { orgId: 'org-1', periodId: 'period-1' })).rejects.toThrow(/match transaction orgId/);
  });

  test('locks account and rejects overlapping scheduled or active periods', async () => {
    const repo = createMysqlPeriodRepository();
    const { tx, calls } = transaction(undefined, async (sql, params) => {
      if (sql.includes('organization_billing_accounts')) return [{ org_id: 'org-1' }];
      if (sql.includes('FROM billing_periods') && sql.includes('starts_at<?')) return [{ id: 'existing-period' }];
      return [];
    });
    await expect(repo.insertScheduledPeriod(tx, period)).rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.PERIOD_INVALID });
    expect(calls[0].sql).toContain('FOR UPDATE');
    expect(calls[1].params).toEqual(['org-1', period.endAt, period.startAt]);
  });

  test('inserts a scheduled row with the supplied immutable snapshot and dates', async () => {
    const repo = createMysqlPeriodRepository();
    const { tx, calls } = transaction(undefined, async (sql, params) => {
      if (sql.includes('organization_billing_accounts')) return [{ org_id: 'org-1' }];
      if (sql.includes('starts_at<?')) return [];
      return { affectedRows: 1 };
    });
    const result = await repo.insertScheduledPeriod(tx, period);
    expect(result.status).toBe('scheduled');
    expect(result.termsSnapshot).toEqual(period.termsSnapshot);
    expect(calls[2].sql).toContain("VALUES (?,?,?,?,?,?,?,'scheduled',?,NULL,NULL,?,?)");
    expect(calls[2].params[7]).toBe(JSON.stringify(period.termsSnapshot));
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('current period lookup is a read-only scope query with a row lock and detects overlap', async () => {
    const repo = createMysqlPeriodRepository();
    const row = dbRow();
    const { tx } = transaction(undefined, async () => [row, { ...row, id: 'period-2' }]);
    await expect(repo.getCurrentPeriodForUpdate(tx, { orgId: 'org-1', at: '2026-01-15T00:00:00Z' }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.RETRYABLE_STORAGE });
  });

  test('activation requires a persisted approved subscription fulfillment for this exact period', async () => {
    const repo = createMysqlPeriodRepository();
    const { tx, calls } = transaction(undefined, async (sql) => {
      if (sql.includes('SELECT id,period_kind,status,starts_at')) return [dbRow()];
      if (sql.includes('billing_payment_fulfillments')) return [];
      return [];
    });
    await expect(repo.transitionPeriod(tx, {
      orgId: 'org-1', periodId: 'period-1', expectedStatus: 'scheduled', status: 'active',
      fields: { activatedAt: '2026-01-15T00:00:00Z', updatedAt: '2026-01-15T00:00:00Z' },
      fundingProof: { paymentRequestId: 'pay-1' },
    })).rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED });
    expect(calls.some((call) => call.sql.includes("fulfillment_kind='subscription_period'"))).toBe(true);
  });

  test('activates a due period only after approved fulfillment is present', async () => {
    const repo = createMysqlPeriodRepository();
    const { tx, calls } = transaction(undefined, async (sql) => {
      if (sql.includes('SELECT id,period_kind,status,starts_at')) return [dbRow()];
      if (sql.includes('billing_payment_fulfillments')) return [{ id: 'fulfill-1' }];
      if (sql.includes("purpose='subscription' AND status='approved'")) return [{ id: 'pay-1' }];
      if (sql.startsWith('UPDATE billing_periods')) return { affectedRows: 1 };
      if (sql.includes('FROM billing_periods WHERE org_id=? AND id=?')) return [dbRow({
        status: 'active', activated_at: '2026-01-15 00:00:00.000000', updated_at: '2026-01-15 00:00:00.000000',
      })];
      return [];
    });
    const result = await repo.transitionPeriod(tx, {
      orgId: 'org-1', periodId: 'period-1', expectedStatus: 'scheduled', status: 'active',
      fields: { activatedAt: '2026-01-15T00:00:00Z', updatedAt: '2026-01-15T00:00:00Z' },
      fundingProof: { paymentRequestId: 'pay-1' },
    });
    expect(result.status).toBe('active');
    expect(result.activatedAt).toBe('2026-01-15T00:00:00.000Z');
    expect(calls.some((call) => call.sql.startsWith('UPDATE billing_periods'))).toBe(true);
  });

  test('activation rejects early/expired timestamps and refuses a changed terms snapshot', async () => {
    const repo = createMysqlPeriodRepository();
    const { tx } = transaction(undefined, async (sql) => sql.includes('SELECT id,period_kind,status,starts_at') ? [dbRow()] : []);
    await expect(repo.transitionPeriod(tx, {
      orgId: 'org-1', periodId: 'period-1', expectedStatus: 'scheduled', status: 'active',
      fields: { activatedAt: '2025-12-31T23:59:59Z', updatedAt: '2025-12-31T23:59:59Z' },
      fundingProof: { paymentRequestId: 'pay-1' },
    })).rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.PERIOD_INVALID });
    await expect(repo.transitionPeriod(tx, {
      orgId: 'org-1', periodId: 'period-1', expectedStatus: 'scheduled', status: 'active',
      fields: { termsSnapshot: { schemaVersion: 1 }, updatedAt: '2026-01-15T00:00:00Z' },
    })).rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.PERIOD_INVALID });
  });

  test('postpaid activation requires explicit permission and cannot be inferred from a paid subscription', async () => {
    const repo = createMysqlPeriodRepository();
    const postpaid = dbRow({ period_kind: 'postpaid' });
    const { tx } = transaction(undefined, async (sql) => {
      if (sql.includes('SELECT id,period_kind,status,starts_at')) return [postpaid];
      if (sql.includes('postpaid_eligible,status,hold_reason')) return [{ postpaid_eligible: 1, status: 'active', hold_reason: null }];
      return [];
    });
    const args = { orgId: 'org-1', periodId: 'period-1', expectedStatus: 'scheduled', status: 'active',
      fields: { activatedAt: '2026-01-15T00:00:00Z', updatedAt: '2026-01-15T00:00:00Z' } };
    await expect(repo.transitionPeriod(tx, args)).rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED });
    await expect(repo.transitionPeriod(tx, { ...args, allowPostpaidActivation: true }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY });
  });

  test('returns purchased plan terms from the approved quote snapshot, not current organization terms', async () => {
    const repo = createMysqlPeriodRepository();
    const purchasedSnapshot = { schemaVersion: 1, plan: { id: 'plan-1', version: 2, terms: { billingInterval: { unit: 'month', count: 1 } } }, includedCredits: { asset: 'voice', units: '100', scale: 0 } };
    const { tx, calls } = transaction(undefined, async (sql) => sql.includes('JOIN billing_quotes') ? [{
      payment_request_id: 'pay-1', period_id: null, quote_id: 'quote-1', quote_type: 'purchase',
      quote_status: 'paid', reviewed_at: '2026-01-15 00:00:00.000000', paid_at: '2026-01-15 00:00:00.000000', terms_snapshot_json: JSON.stringify(purchasedSnapshot),
    }] : []);
    const result = await repo.getApprovedSubscriptionPurchase(tx, { orgId: 'org-1', paymentRequestId: 'pay-1' });
    expect(result.effectiveTerms).toEqual(purchasedSnapshot.plan.terms);
    expect(result.termsSnapshot).toEqual(purchasedSnapshot);
    expect(result.purchaseAt).toBe('2026-01-15T00:00:00.000Z');
    expect(Object.isFrozen(result.termsSnapshot.plan.terms)).toBe(true);
    expect(calls[0].sql).toContain("p.status='approved'");
    expect(calls[0].sql).toContain("q.quote_type IN ('purchase','renewal')");
  });

  test('links an approved payment to its scheduled period with an idempotent fulfillment record', async () => {
    const repo = createMysqlPeriodRepository();
    let linked = false;
    const { tx, calls } = transaction(undefined, async (sql, params) => {
      if (sql.includes('SELECT id,period_kind,status FROM billing_periods')) return [{ id: 'period-1', period_kind: 'subscription', status: 'scheduled' }];
      if (sql.includes('SELECT id,period_id,status,purpose FROM billing_payment_requests')) return [{ id: 'pay-1', period_id: linked ? 'period-1' : null, status: 'approved', purpose: 'subscription' }];
      if (sql.startsWith('UPDATE billing_payment_requests')) { linked = true; return { affectedRows: 1 }; }
      if (sql.includes('FROM billing_payment_fulfillments')) return linkedFulfillment;
      if (sql.startsWith('INSERT INTO billing_payment_fulfillments')) { linkedFulfillment = [{ id: params[0] }]; return { affectedRows: 1 }; }
      return [];
    });
    let linkedFulfillment = [];
    const first = await repo.linkApprovedSubscriptionPayment(tx, { orgId: 'org-1', paymentRequestId: 'pay-1', periodId: 'period-1', now: '2026-01-15T00:00:00Z' });
    expect(first.alreadyLinked).toBe(false);
    expect(calls.some((call) => call.sql.startsWith('UPDATE billing_payment_requests'))).toBe(true);
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO billing_payment_fulfillments'))).toBe(true);
    const second = await repo.linkApprovedSubscriptionPayment(tx, { orgId: 'org-1', paymentRequestId: 'pay-1', periodId: 'period-1', now: '2026-01-15T00:00:00Z' });
    expect(second.alreadyLinked).toBe(true);
    expect(calls.filter((call) => call.sql.startsWith('INSERT INTO billing_payment_fulfillments'))).toHaveLength(1);
  });
});
