'use strict';
jest.mock('../../src/db/pool', () => ({ getPool: jest.fn() }));
jest.mock('../../src/platform/billingSettings', () => ({ getWorkspacePlans: jest.fn() }));
const { readPlanCreditStatus, resolvePlanMonthlyCredits, inrAmount } = require('../../src/billing/planCreditStatus');
const { getWorkspacePlans } = require('../../src/platform/billingSettings');

const policy = {
  planId:'enterprise', planVersion:7,
  pricing:{ monthlySubscriptionCreditsInr:2500.25 },
};
const row = overrides => ({
  subscription_plan:'Enterprise',
  settings:JSON.stringify({workspacePolicy:policy}), ...overrides,
});
const period = {id:'period-paid',status:'scheduled',starts_at:'2026-10-01T00:00:00.000Z',
  ends_at:'2026-11-01T00:00:00.000Z' };
function fixture({ organization = row(), periods = [], grants = [], funded = [], allocations = [] } = {}) {
  const calls = [];
  const pool = { query: jest.fn(async(sql,args) => {
    calls.push({sql,args});
    if (sql.includes('FROM organizations')) return {rows:organization ? [organization] : []};
    if (sql.includes('FROM billing_periods')) return {rows:periods};
    if (sql.includes('FROM billing_credit_grants')) return {rows:grants};
    if (sql.includes('FROM billing_journals')) return {rows:allocations};
    if (sql.includes('FROM billing_payment_fulfillments')) return {rows:funded};
    throw Error('Unexpected SQL: '+sql);
  })};
  return { pool, calls };
}
const now = new Date('2026-10-11T12:00:00Z');

describe('monthly Enterprise plan included credit source', () => {
  beforeEach(()=>jest.clearAllMocks());
  test('formats valid plan allowance in exact INR subunits', () => {
    expect(inrAmount(2500.25)).toEqual({asset:'INR',units:'250025',scale:2});
    for (const invalid of [-1,10.123,Infinity,NaN,'2500']) expect(inrAmount(invalid)).toBeNull();
  });
  test('preserves the newly stored snapshot rather than following modified platform pricing', () => {
    expect(resolvePlanMonthlyCredits(policy,{version:10,plans:[]})).toEqual({
      source:'organization_plan_snapshot',amount:{asset:'INR',units:'250025',scale:2},
    });
  });
  test('recovers missing older snapshot only for the exact still-current catalog version', () => {
    const old = {planId:'enterprise',planVersion:7,pricing:{baseMonthlyInr:10000}};
    const catalog={version:7,plans:[{id:'enterprise',pricing:{monthlySubscriptionCreditsInr:3000}}]};
    expect(resolvePlanMonthlyCredits(old,catalog)).toEqual({
      source:'matching_platform_plan_version',amount:{asset:'INR',units:'300000',scale:2},
    });
    expect(resolvePlanMonthlyCredits(old,{...catalog,version:8})).toEqual({
      source:'unverified_legacy_plan',amount:null,
    });
  });
  test('reports correctly configured but unfunded new Enterprise organization without minting credits', async () => {
    const {pool,calls}=fixture();
    const result=await readPlanCreditStatus('org-1',{pool,now});
    expect(result).toMatchObject({
      planName:'Enterprise',state:'awaiting_approved_subscription',
      configuredMonthlyCredits:{asset:'INR',units:'250025',scale:2},
      issuedThisPeriod:null,
    });
    expect(calls).toHaveLength(2);
    expect(calls.every(call=>/^SELECT\s/.test(call.sql))).toBe(true);
    expect(calls.every(call=>call.args[0]==='org-1')).toBe(true);
  });
  test('shows approved payment awaiting activation rather than available credits', async () => {
    const {pool}=fixture({periods:[period],funded:[{id:'fulfilled'}]});
    const result=await readPlanCreditStatus('org-1',{pool,now});
    expect(result.state).toBe('awaiting_period_activation');
    expect(result.issuedThisPeriod).toBeNull();
  });
  test('never treats scheduled unfunded subscription as granted', async () => {
    const {pool}=fixture({periods:[period]});
    const result=await readPlanCreditStatus('org-1',{pool,now});
    expect(result.state).toBe('awaiting_approved_subscription');
    expect(result.issuedThisPeriod).toBeNull();
  });
  test('identifies a funded and active period as issued to organization pool', async () => {
    const {pool}=fixture({periods:[{...period,status:'active'}],grants:[
      {id:'grant-1',status:'active',amount_units:'250025',asset:'INR',scale:2},
    ]});
    const result=await readPlanCreditStatus('org-1',{pool,now});
    expect(result).toMatchObject({state:'issued_to_organization_pool',
      issuedThisPeriod:{asset:'INR',units:'250025',scale:2}});
  });
  test('identifies a subscription grant transferred into a workspace', async () => {
    const {pool}=fixture({periods:[{...period,status:'active'}],grants:[
      {id:'grant-1',status:'active',amount_units:'250025',asset:'INR',scale:2},
    ],allocations:[{id:'journal-1'}]});
    const result=await readPlanCreditStatus('org-1',{pool,now});
    expect(result).toMatchObject({state:'issued_to_workspace',issuedThisPeriod:{units:'250025'}});
  });
  test('flags missing grant for active period without inventing a balance', async () => {
    const {pool}=fixture({periods:[{...period,status:'active'}]});
    const result=await readPlanCreditStatus('org-1',{pool,now});
    expect(result.state).toBe('activation_incomplete');
    expect(result.issuedThisPeriod).toBeNull();
  });
  test('reports original credit value for legacy organization only if plan version matches', async () => {
    const older = row({settings:JSON.stringify({workspacePolicy:{planId:'enterprise',planVersion:7,pricing:{baseMonthlyInr:8000}}})});
    getWorkspacePlans.mockResolvedValue({version:7,plans:[{id:'enterprise',pricing:{monthlySubscriptionCreditsInr:2500}}]});
    const matched=await readPlanCreditStatus('org-1',{pool:fixture({organization:older}).pool,now});
    expect(matched).toMatchObject({entitlementSource:'matching_platform_plan_version',
      configuredMonthlyCredits:{units:'250000'}});
    getWorkspacePlans.mockResolvedValue({version:8,plans:[{id:'enterprise',pricing:{monthlySubscriptionCreditsInr:3000}}]});
    const stale=await readPlanCreditStatus('org-1',{pool:fixture({organization:older}).pool,now});
    expect(stale).toMatchObject({entitlementSource:'unverified_legacy_plan',configuredMonthlyCredits:null,
      state:'unverified_plan'});
  });
});
