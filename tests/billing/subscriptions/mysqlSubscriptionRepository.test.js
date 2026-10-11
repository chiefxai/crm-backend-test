'use strict';

const { createMysqlSubscriptionRepository } = require('../../../src/billing/modules/subscriptions/repositories/mysqlSubscriptionRepository');
const { createTransactionContext } = require('../../../src/billing/kernel/transactionContext');

function transaction(handler = async () => []) {
  const calls = [];
  const tx = createTransactionContext({ async query(sql, params) { calls.push({ sql, params }); return handler(sql, params, calls.length); } }, { orgId: 'org-1' });
  return { tx, calls };
}
function graceRow(overrides = {}) {
  return { id: 'grace-1', org_id: 'org-1', period_id: 'period-1', requested_until: '2026-06-08 00:00:00.000000',
    justification: 'Invoice processing delay', requested_by: 'admin-1', status: 'requested', granted_until: null,
    version: 1, created_at: '2026-06-01 00:00:00.000000', updated_at: '2026-06-01 00:00:00.000000', ...overrides };
}

describe('MySQL subscription persistence repository', () => {
  test('enforces organization scope before touching lifecycle records', async () => {
    const repo = createMysqlSubscriptionRepository();
    const { tx, calls } = transaction();
    await expect(repo.getOrganizationSubscription(tx, { orgId: 'org-2' })).rejects.toThrow(/match transaction orgId/);
    expect(calls).toHaveLength(0);
  });

  test('creates an organization subscription in billing recovery with explicit policy and deadline', async () => {
    const repo = createMysqlSubscriptionRepository();
    const { tx, calls } = transaction(async (sql) => sql.includes('FROM organization_subscriptions') ? [{
      org_id: 'org-1', lifecycle_status: 'onboarding', current_plan_id: 'plan-1', current_plan_version: 3,
      current_period_id: null, billing_access_state: 'billing_recovery', billing_suspension_cause: null,
      restriction_deadline: '2026-06-08 00:00:00.000000', access_policy_json: '{"postExpiryGraceDays":7}',
      version: 1, created_at: '2026-06-01 00:00:00.000000', updated_at: '2026-06-01 00:00:00.000000',
    }] : { affectedRows: 1 });
    const result = await repo.createOrganizationSubscription(tx, {
      orgId: 'org-1', lifecycleStatus: 'onboarding', currentPlanId: 'plan-1', currentPlanVersion: 3,
      billingAccessState: 'billing_recovery', restrictionDeadline: '2026-06-08T00:00:00Z',
      accessPolicy: { postExpiryGraceDays: 7 }, now: '2026-06-01T00:00:00Z',
    });
    expect(result.billingAccessState).toBe('billing_recovery');
    expect(result.restrictionDeadline).toBe('2026-06-08T00:00:00.000Z');
    expect(calls[0].sql).toContain('organization_subscriptions');
    expect(calls[0].sql).toContain('current_period_id');
  });

  test('records approval and later revocation as sequenced decisions while retaining the reason and actor', async () => {
    const repo = createMysqlSubscriptionRepository();
    let status = 'requested';
    let version = 1;
    const decisions = [];
    const { tx, calls } = transaction(async (sql, params) => {
      if (sql.includes('FROM billing_subscription_grace_requests')) return [graceRow({ status, version,
        granted_until: status === 'approved' ? '2026-06-08 00:00:00.000000' : null })];
      if (sql.startsWith('INSERT INTO billing_subscription_grace_decisions')) { decisions.push(params); return { affectedRows: 1 }; }
      if (sql.startsWith('UPDATE billing_subscription_grace_requests')) { status = params[0]; version += 1; return { affectedRows: 1 }; }
      return [];
    });
    const approved = await repo.recordGraceDecision(tx, { id: 'decision-1', orgId: 'org-1', graceRequestId: 'grace-1',
      decision: 'approve', reason: 'Bank reconciliation confirmed', decidedBy: 'platform-1', grantedUntil: '2026-06-08T00:00:00Z',
      expectedVersion: 1, now: '2026-06-01T00:00:00Z' });
    expect(approved.status).toBe('approved');
    const revoked = await repo.recordGraceDecision(tx, { id: 'decision-2', orgId: 'org-1', graceRequestId: 'grace-1',
      decision: 'revoke', reason: 'Payment review completed', decidedBy: 'platform-2', expectedVersion: 2, now: '2026-06-02T00:00:00Z' });
    expect(revoked.status).toBe('revoked');
    expect(decisions.map((params) => params[3])).toEqual([1, 2]);
    expect(decisions.map((params) => params[5])).toEqual(['Bank reconciliation confirmed', 'Payment review completed']);
    expect(decisions.map((params) => params[6])).toEqual(['platform-1', 'platform-2']);
    expect(calls.filter((call) => call.sql.includes('FOR UPDATE'))).toHaveLength(2);
  });

  test('rejects a grace decision from a stale request version', async () => {
    const repo = createMysqlSubscriptionRepository();
    const { tx, calls } = transaction(async (sql) => sql.includes('FROM billing_subscription_grace_requests') ? [graceRow({ version: 4 })] : []);
    const result = await repo.recordGraceDecision(tx, { id: 'decision-1', orgId: 'org-1', graceRequestId: 'grace-1',
      decision: 'approve', reason: 'Approved', decidedBy: 'platform-1', grantedUntil: '2026-06-08T00:00:00Z',
      expectedVersion: 2, now: '2026-06-01T00:00:00Z' });
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('links a paid quote to its scheduled period and advances the independent period lifecycle state', async () => {
    const repo = createMysqlSubscriptionRepository();
    let link = { id: 'link-1', org_id: 'org-1', period_id: null, quote_id: 'quote-1', payment_request_id: null,
      purpose: 'initial_purchase', period_state: 'awaiting_payment', plan_id: 'plan-1', plan_version: 2,
      effective_at: null, supersedes_period_id: null, version: 1 };
    const { tx, calls } = transaction(async (sql, params) => {
      if (sql.includes('FROM billing_subscription_period_links')) return [link];
      if (sql.startsWith('UPDATE billing_subscription_period_links')) {
        link = { ...link, period_id: params[0], payment_request_id: params[1], period_state: params[2], version: 2 };
        return { affectedRows: 1 };
      }
      return [];
    });
    const result = await repo.updatePeriodLink(tx, { orgId: 'org-1', linkId: 'link-1', expectedVersion: 1,
      periodId: 'period-1', paymentRequestId: 'payment-1', periodState: 'scheduled',
      now: '2026-06-01T00:00:00Z' });
    expect(result.periodId).toBe('period-1');
    expect(result.periodState).toBe('scheduled');
    expect(calls[0].sql).toContain('FOR UPDATE');
    await expect(repo.updatePeriodLink(tx, { orgId: 'org-1', linkId: 'link-1', expectedVersion: 2,
      periodState: 'awaiting_payment', now: '2026-06-01T00:00:00Z' })).rejects.toThrow(/Cannot transition/);
  });

});
