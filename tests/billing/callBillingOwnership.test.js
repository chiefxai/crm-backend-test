jest.mock('../../src/db/repository', () => ({ list: jest.fn().mockResolvedValue([]) }));
jest.mock('../../src/platform/costProviders', () => ({ computeCallCost: jest.fn().mockResolvedValue({ totalCost: 12, pricingVersion: 'v1', rateAmount: 1, rateUnit: 'minute' }) }));
jest.mock('../../src/billing/orgServices', () => ({ getOrgServiceProfile: jest.fn(() => ({ phoneEnabled: true, aiEnabled: false })) }));
jest.mock('../../src/billing/pricingResolver', () => ({ resolveCallProviderPricing: jest.fn().mockResolvedValue({ provider: { active: true, rateAmount: 1 } }) }));

const costProviders = require('../../src/platform/costProviders');
const { computeCallBillingBreakdown } = require('../../src/billing/callBillingService');
const db = require('../../src/db/repository');
const { isCallProviderChargeBillable, phoneChargesAreBillable } = require('../../src/crm/billingEngine');

describe('telephony ownership billing', () => {
  beforeEach(() => jest.clearAllMocks());

  test('organization-owned provider calls do not add platform provider cost', async () => {
    const result = await computeCallBillingBreakdown({ org: { id: 'org-1' }, providerKey: 'vobiz', durationSeconds: 60, telephonyOwnerType: 'organization' });
    expect(costProviders.computeCallCost).not.toHaveBeenCalled();
    expect(result.providerCostInr).toBe(0);
    expect(result.telephonyOwnerType).toBe('organization');
  });

  test('platform-owned and legacy calls retain provider cost calculation', async () => {
    const platformResult = await computeCallBillingBreakdown({ org: { id: 'org-1' }, providerKey: 'vobiz', durationSeconds: 60, telephonyOwnerType: 'platform' });
    const legacyResult = await computeCallBillingBreakdown({ org: { id: 'org-1' }, providerKey: 'vobiz', durationSeconds: 60 });
    expect(costProviders.computeCallCost).toHaveBeenCalledTimes(2);
    expect(platformResult.providerCostInr).toBe(12);
    expect(legacyResult.providerCostInr).toBe(12);
    expect(legacyResult.telephonyOwnerType).toBeNull();
  });

  test('billing summaries use each call ownership snapshot for mixed connector accounts', async () => {
    db.list.mockResolvedValue([
      { createdAt: '2026-10-03T10:00:00.000Z', telephonyOwnerType: 'organization' },
      { createdAt: '2026-10-04T10:00:00.000Z', snapshot: { telephonyOwnerType: 'platform' } },
    ]);

    await expect(phoneChargesAreBillable(
      { id: 'org-1', billingPeriodEnd: '2026-10-31' },
      true,
    )).resolves.toBe(true);
    expect(isCallProviderChargeBillable({ telephonyOwnerType: 'organization' }, false)).toBe(false);
    expect(isCallProviderChargeBillable({ telephonyOwnerType: 'platform' }, true)).toBe(true);
  });

  test('billing summaries exclude the provider estimate when all current calls use org-owned accounts', async () => {
    db.list.mockResolvedValue([
      { createdAt: '2026-10-03T10:00:00.000Z', telephonyOwnerType: 'organization' },
    ]);

    await expect(phoneChargesAreBillable(
      { id: 'org-1', billingPeriodEnd: '2026-10-31' },
      false,
    )).resolves.toBe(false);
  });
});
