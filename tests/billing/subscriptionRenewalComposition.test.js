'use strict';

const mockTx = { query: jest.fn(async () => ({ rows: [] })) };

jest.mock('../../src/billing/adapters/mysql/unitOfWork', () => ({
  createMysqlUnitOfWork: () => ({
    runFinancial: async ({ callback }) => {
      const result = await callback(mockTx);
      const encoded = JSON.stringify(result);
      if (encoded === undefined) throw new Error('Financial command result must be a JSON object.');
      const parsed = JSON.parse(encoded);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Financial command result must be a JSON object.');
      }
      return parsed;
    },
  }),
}));
jest.mock('../../src/billing/adapters/mysql/commandOperationRepository', () => ({}));
jest.mock('../../src/billing/modules/catalog/repositories/mysqlSubscriptionQuoteRepository', () => ({
  createMysqlSubscriptionQuoteRepository: () => ({
    getByIdempotencyKey: jest.fn(async () => null),
    create: jest.fn(async () => undefined),
  }),
}));
jest.mock('../../src/billing/modules/subscriptions/repositories/mysqlSubscriptionRepository', () => ({
  createMysqlSubscriptionRepository: () => ({
    getOrganizationSubscription: jest.fn(async () => ({ currentPlanId: 'starter', currentPlanVersion: 1 })),
    linkPeriod: jest.fn(async () => undefined),
  }),
}));
jest.mock('../../src/billing/subscriptionPurchaseComposition', () => ({
  inventoryFrom: () => ({ workspaceCount: 1, industries: [{ code: 'technology', count: 1 }], seatCount: 1,
    separatelyBilledWorkspaceCount: 0, version: 'sha256:test' }),
  quoteTtlSeconds: () => 3600,
}));
jest.mock('../../src/billing/modules/catalog/subscriptionQuoteComposition', () => ({
  composeSubscriptionQuote: () => ({ quoteId: 'renewal-quote-1', total: { currency: 'INR', units: '1000' } }),
}));

const { createSubscriptionRenewalComposition } = require('../../src/billing/subscriptionRenewalComposition');

describe('early-paid credits read model',()=>{
  test('reports actual approved paid grant separately from trial credits',async()=>{
    const pool={query:jest.fn(async sql=>{
      if(sql.includes('FROM organization_subscriptions'))return {rows:[{
        lifecycle_status:'active',billing_access_state:'operational',
        current_plan_id:'starter',current_plan_version:1,subscription_version:1,restriction_deadline:null,
        period_id:'trial-period',starts_at:'2026-10-08T00:00:00.000Z',
        ends_at:'2026-10-15T00:00:00.000Z',period_status:'active',
        terms_snapshot_json:JSON.stringify({source:'free_trial',trialDays:7}),
        quote_id:null,pending_payments:0,
        scheduled_renewal:JSON.stringify({periodId:'paid-period',status:'scheduled',
          startsAt:'2026-10-15T00:00:00.000Z',endsAt:'2026-11-15T00:00:00.000Z'}),
      }]};
      if(sql.includes('FROM billing_credit_grants'))return {rows:[{
        id:'paid-grant',amount_units:'50000',asset:'INR',scale:2,
        effective_at:'2026-10-12T00:00:00.000Z',expires_at:'2026-11-15T00:00:00.000Z',
      }]};
      return {rows:[]};
    })};
    const composition=createSubscriptionRenewalComposition({pool,
      getPlanVersion:async()=>({planId:'starter',version:1,status:'published',terms:{}}),
      clock:{now:()=> '2026-10-13T00:00:00.000Z'},
    });
    const result=await composition.readRenewal('org-1');
    expect(result.period.isTrial).toBe(true);
    expect(result.paidCreditsDuringTrial).toMatchObject({
      grantId:'paid-grant',amount:{asset:'INR',units:'50000',scale:2},
      expiresAt:'2026-11-15T00:00:00.000Z',
    });
    expect(pool.query.mock.calls.some(([sql])=>sql.includes("g.status='active'"))).toBe(true);
  });
});

describe('subscription renewal quote composition', () => {
  test('returns a JSON object from the financial transaction when creating a quote', async () => {
    const orgId = 'org-1';
    const pool = {
      connect: jest.fn(),
      query: jest.fn(async (sql) => {
        if (sql.includes('FROM organization_subscriptions')) return { rows: [{
          lifecycle_status: 'active', billing_access_state: 'active', current_plan_id: 'starter',
          current_plan_version: 1, subscription_version: 1, restriction_deadline: null,
          period_id: 'period-1', starts_at: '2026-10-01T00:00:00.000Z', ends_at: '2026-10-15T00:00:00.000Z',
          period_status: 'active', terms_snapshot_json: JSON.stringify({ source: 'purchase' }),
          quote_id: null, pending_payments: 0, scheduled_renewal: null,
        }] };
        if (sql.includes('SELECT id,industry FROM workspaces')) return { rows: [{ id: 'workspace-1', industry: 'technology' }] };
        if (sql.includes('SELECT COUNT(*) AS seat_count')) return { rows: [{ seat_count: 1 }] };
        return { rows: [] };
      }),
    };
    const composition = createSubscriptionRenewalComposition({
      pool,
      getPlanVersion: async () => ({ planId: 'starter', version: 1, status: 'published', terms: {} }),
      clock: { now: () => '2026-10-12T00:00:00.000Z' },
      idSource: { newId: (kind) => `${kind}-test` },
    });

    await expect(composition.createRenewalQuote({ orgId, requestKey: 'request-1' })).resolves.toBeTruthy();
  });
});
