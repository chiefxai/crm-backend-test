'use strict';

const { createWorkspacePlanCatalogSyncService } = require('../../src/billing/workspacePlanCatalogSync');

const sourcePlan = {
  id: 'enterprise', name: 'Enterprise', active: true, defaultMode: 'single',
  industryModules: { lending: ['loan_lifecycle'] },
  pricing: { baseMonthlyInr: 3000, includedWorkspaces: 1, maxWorkspaces: 1, extraWorkspaceMonthlyInr: 0,
    includedSeats: 20, maxSeats: null, extraSeatMonthlyInr: 25, additionalIndustryMonthlyInr: 0, monthlySubscriptionCreditsInr: 4000 },
};
const policy = { includedDistinctIndustries: 1, maxDistinctIndustries: null, taxes: [],
  postpaid: { eligible: false, workspaceModes: [], organizationExposureLimit: null },
  serviceAfterExpiry: { mode: 'suspend', graceSeconds: 0 } };

function setup({ configured = true, current = null } = {}) {
  const calls = [];
  const catalogService = {
    listPlans: jest.fn(async () => current ? [{ id: 'plan-enterprise', code: 'enterprise', displayName: 'Enterprise', status: 'active' }] : []),
    createPlan: jest.fn(async ({ code, displayName, terms }) => {
      calls.push(['createPlan', code, terms]);
      return { plan: { id: 'plan-enterprise', code, displayName }, version: { version: 1, terms, status: 'draft' } };
    }),
    publishDraft: jest.fn(async ({ planId, version, effectiveFrom }) => {
      calls.push(['publishDraft', planId, version, effectiveFrom]);
      return { id: `v${version}`, planId, version, status: 'published', effectiveFrom, effectiveTo: null, terms: current?.terms || termsFor(sourcePlan) };
    }),
    getVersion: jest.fn(),
    getEffectiveVersion: jest.fn(async () => current),
    listVersions: jest.fn(async () => []),
    createDraftVersion: jest.fn(),
  };
  const service = createWorkspacePlanCatalogSyncService({
    getWorkspacePlans: async () => ({ version: 12, plans: [sourcePlan] }),
    getBillingPolicy: async () => ({ configured, policy: configured ? policy : null }),
    catalogService,
    clock: { now: () => '2026-10-11T00:00:00.000Z' },
  });
  return { service, catalogService, calls };
}

function termsFor(plan) {
  const { mapWorkspacePlanToTerms } = require('../../src/billing/modules/catalog/workspacePlanMapper');
  return mapWorkspacePlanToTerms(plan, policy);
}

test('fails closed until platform financial terms are explicitly configured', async () => {
  const { service, catalogService } = setup({ configured: false });
  await expect(service.resolvePlanVersion({ workspacePlanId: 'enterprise', workspacePlanVersion: 12 }))
    .rejects.toMatchObject({ code: 'SUBSCRIPTION_TERMS_NOT_CONFIGURED', statusCode: 409 });
  expect(catalogService.createPlan).not.toHaveBeenCalled();
});

test('publishes a versioned financial plan with subscription fee and included credits kept separate', async () => {
  const { service, catalogService } = setup();
  catalogService.publishDraft.mockImplementation(async ({ planId, version, effectiveFrom }) => ({
    id: `v${version}`, planId, version, status: 'published', effectiveFrom, effectiveTo: null, terms: termsFor(sourcePlan),
  }));
  const result = await service.resolvePlanVersion({ workspacePlanId: 'enterprise', workspacePlanVersion: 12 });
  expect(result).toMatchObject({ planId: 'plan-enterprise', version: 1, status: 'published' });
  expect(result.terms.subscriptionPrice.units).toBe('300000');
  expect(result.terms.includedCredits.units).toBe('400000');
  expect(catalogService.createPlan).toHaveBeenCalledTimes(1);
  expect(catalogService.publishDraft).toHaveBeenCalledTimes(1);
});

test('reuses a matching published version and rejects stale source settings', async () => {
  const existing = { planId: 'plan-enterprise', version: 3, status: 'published', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, terms: termsFor(sourcePlan) };
  const { service, catalogService } = setup({ current: existing });
  await expect(service.resolvePlanVersion({ workspacePlanId: 'enterprise', workspacePlanVersion: 12 })).resolves.toBe(existing);
  expect(catalogService.createDraftVersion).not.toHaveBeenCalled();
  await expect(service.resolvePlanVersion({ workspacePlanId: 'enterprise', workspacePlanVersion: 11 }))
    .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
});
