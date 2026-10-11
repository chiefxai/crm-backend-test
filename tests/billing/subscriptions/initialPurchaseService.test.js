'use strict';

const { createInitialPurchaseService } = require('../../../src/billing/modules/subscriptions/initialPurchaseService');

const terms = {
  schemaVersion: 1, currency: 'INR', billingInterval: { unit: 'month', count: 1 },
  subscriptionPrice: { asset: 'INR', units: '300000', scale: 2 },
  structure: { mode: 'single', includedWorkspaces: 1, includedDistinctIndustries: 1, maxWorkspaces: 1, maxDistinctIndustries: 1, orgAdminWorkspaceIndustry: 'primary_only' },
  workspaceFees: { additionalWorkspace: { asset: 'INR', units: '0', scale: 2 }, additionalDistinctIndustry: { asset: 'INR', units: '0', scale: 2 } },
  seats: { included: 20, max: null, additionalSeat: { asset: 'INR', units: '2500', scale: 2 } },
  industryModules: { lending: ['campaigns'] },
  includedCredits: { asset: 'INR', units: '400000', scale: 2 }, taxes: [],
  postpaid: { eligible: false, workspaceModes: [], organizationExposureLimit: null },
  serviceAfterExpiry: { mode: 'suspend', graceSeconds: 0 },
};
const planVersion = { planId: 'enterprise', version: 2, status: 'published', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null, terms };

function dependencies(overrides = {}) {
  const writes = {};
  const quoteRepository = {
    getByIdempotencyKey: jest.fn(async () => null),
    create: jest.fn(async (_tx, value) => { writes.quote = value; return { id: value.id, status: 'draft', version: value.quote.version }; }),
  };
  const subscriptionRepository = {
    getOrganizationSubscription: jest.fn(async () => null),
    createOrganizationSubscription: jest.fn(async (_tx, value) => { writes.subscription = value; }),
    linkPeriod: jest.fn(async (_tx, value) => { writes.link = value; return { id: value.id, periodState: value.periodState }; }),
  };
  const unitOfWork = { runFinancial: jest.fn(async ({ callback }) => callback({ metadata: { orgId: 'org-1' } })) };
  let sequence = 0;
  return {
    writes,
    service: createInitialPurchaseService({
      unitOfWork, quoteRepository, subscriptionRepository,
      planCatalogService: { getVersion: jest.fn(async () => planVersion) },
      idSource: { newId: (kind) => `${kind}-${++sequence}` },
      clock: { now: () => '2026-10-11T00:00:00Z' },
      ...overrides,
    }),
    quoteRepository, subscriptionRepository, unitOfWork,
  };
}

describe('initial organization subscription purchase provisioning', () => {
  test('creates a billing-only onboarding subscription, immutable purchase quote and awaiting-payment link atomically', async () => {
    const deps = dependencies();
    const result = await deps.service.provision({
      orgId: 'org-1', planId: 'enterprise', planVersion: 2,
      inventory: { workspaceCount: 1, industryCodes: ['lending'], version: 1 },
      validUntil: '2026-10-12T00:00:00Z', idempotencyKey: 'initial-org-1',
      accessPolicy: { initialUnpaidAccess: 'billing_recovery', billingTimeZone: 'UTC' },
    });

    expect(deps.unitOfWork.runFinancial).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', operationId: expect.stringMatching(/^subscription-initial-[a-f0-9]{40}$/), requestFingerprint: expect.stringMatching(/^sha256:/),
    }));
    expect(deps.writes.subscription).toMatchObject({ lifecycleStatus: 'onboarding', billingAccessState: 'billing_recovery', currentPlanId: 'enterprise', currentPlanVersion: 2 });
    expect(deps.writes.quote.quote).toMatchObject({ purpose: 'purchase', total: { asset: 'INR', units: '300000', scale: 2 }, includedCredits: { asset: 'INR', units: '400000', scale: 2 } });
    expect(deps.writes.link).toMatchObject({ purpose: 'initial_purchase', periodState: 'awaiting_payment', quoteId: result.quoteId });
    expect(result).toMatchObject({ lifecycleStatus: 'onboarding', billingAccessState: 'billing_recovery', paymentAmount: { units: '300000' }, includedCredits: { units: '400000' }, periodState: 'awaiting_payment' });
  });

  test('rejects mismatched transaction scope and invalid initial access policy', async () => {
    const scopeDeps = dependencies();
    scopeDeps.unitOfWork.runFinancial.mockImplementation(async ({ callback }) => callback({ metadata: { orgId: 'other-org' } }));
    await expect(scopeDeps.service.provision({ orgId: 'org-1', planId: 'enterprise', planVersion: 2,
      inventory: { workspaceCount: 1, industryCodes: ['lending'] }, validUntil: '2026-10-12T00:00:00Z',
      accessPolicy: { initialUnpaidAccess: 'billing_recovery' } })).rejects.toThrow(/transaction organization mismatch/);

    const policyDeps = dependencies();
    await expect(policyDeps.service.provision({ orgId: 'org-1', planId: 'enterprise', planVersion: 2,
      inventory: { workspaceCount: 1, industryCodes: ['lending'] }, validUntil: '2026-10-12T00:00:00Z',
      accessPolicy: { initialUnpaidAccess: 'operational' } })).rejects.toThrow(/initialUnpaidAccess to billing_recovery/);
    expect(policyDeps.unitOfWork.runFinancial).not.toHaveBeenCalled();
  });

  test('does not quote a non-published or ineffective catalog version', async () => {
    const deps = dependencies({ planCatalogService: { getVersion: async () => ({ ...planVersion, status: 'draft' }) } });
    await expect(deps.service.provision({ orgId: 'org-1', planId: 'enterprise', planVersion: 2,
      inventory: { workspaceCount: 1, industryCodes: ['lending'] }, validUntil: '2026-10-12T00:00:00Z',
      accessPolicy: { initialUnpaidAccess: 'billing_recovery' } })).rejects.toThrow(/Only a published plan version/);
    expect(deps.unitOfWork.runFinancial).not.toHaveBeenCalled();
  });
});
