'use strict';

const { createTransactionContext } = require('../../../src/billing/kernel/transactionContext');
const { createOrganizationTermsService } = require('../../../src/billing/modules/catalog');

const PLAN_TERMS = {
  schemaVersion: 1,
  currency: 'INR',
  billingInterval: { unit: 'month', count: 1 },
  subscriptionPrice: { asset: 'INR', units: '1000000', scale: 6 },
  structure: { mode: 'same_industry', includedWorkspaces: 1, includedDistinctIndustries: 1, maxWorkspaces: 10, maxDistinctIndustries: 1, orgAdminWorkspaceIndustry: 'primary_only' },
  workspaceFees: { additionalWorkspace: { asset: 'INR', units: '10000', scale: 6 }, additionalDistinctIndustry: { asset: 'INR', units: '50000', scale: 6 } },
  includedCredits: { asset: 'CREDITS', units: '1000', scale: 0 },
  taxes: [],
  postpaid: { eligible: false, workspaceModes: [], organizationExposureLimit: null },
  serviceAfterExpiry: { mode: 'suspend', graceSeconds: 0 },
};
const PLAN_VERSION = {
  id: 'pv-1', planId: 'plan-a', version: 1, status: 'published',
  effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, terms: PLAN_TERMS,
};
function tx(orgId = 'org-a') { return createTransactionContext({ query: async () => [] }, { orgId, operationId: 'op-1', billingAccountVersion: 1 }); }

function memoryRepository() {
  const records = [];
  return {
    records,
    async insertEffectiveTerms(_tx, record) {
      if (records.some((item) => item.orgId === record.orgId && item.effectiveFrom >= record.effectiveAt)) throw Object.assign(new Error('overlap/future'), { code: 'BILLING_VERSION_CONFLICT' });
      const current = records.find((item) => item.orgId === record.orgId && (!item.effectiveTo || item.effectiveTo > record.effectiveAt));
      if (current) current.effectiveTo = record.effectiveAt;
      const saved = {
        id: record.id, orgId: record.orgId, version: records.filter((item) => item.orgId === record.orgId).length + 1,
        planId: record.planVersion.planId, planVersion: record.planVersion.version,
        effectiveFrom: record.effectiveAt, effectiveTo: null,
        planSnapshot: { id: record.planVersion.id, planId: record.planVersion.planId, version: record.planVersion.version, terms: record.planVersion.terms },
        effectiveTerms: record.effectiveTerms, overrides: record.overrides, createdBy: record.actorId,
      };
      records.push(saved);
      return saved;
    },
    async getEffectiveTerms(_tx, { orgId, at }) {
      return records.find((item) => item.orgId === orgId && item.effectiveFrom <= at && (!item.effectiveTo || item.effectiveTo > at)) || null;
    },
  };
}

describe('effective organization billing terms', () => {
  test('stores a full immutable plan reference and resolved terms for an effective override', async () => {
    const repository = memoryRepository();
    const service = createOrganizationTermsService({
      repository,
      idSource: { newId: () => 'org-terms-1' },
      clock: { now: () => '2026-10-08T00:00:00.000Z' },
    });
    const saved = await service.setEffectiveTerms(tx(), {
      orgId: 'org-a', planVersion: PLAN_VERSION,
      overrides: { structure: { maxWorkspaces: 25 }, includedCredits: { asset: 'CREDITS', units: '2000', scale: 0 } },
      effectiveAt: '2026-10-08T00:00:00.000Z', actorId: 'platform-user-1', changeReason: 'Expansion approved',
    });
    expect(saved.planSnapshot).toMatchObject({ id: 'pv-1', planId: 'plan-a', version: 1 });
    expect(saved.effectiveTerms.structure.maxWorkspaces).toBe(25);
    expect(saved.effectiveTerms.includedCredits.units).toBe('2000');
    expect(saved.createdBy).toBe('platform-user-1');
    expect((await service.getEffectiveTerms(tx(), { orgId: 'org-a', at: '2026-10-09T00:00:00.000Z' })).id).toBe('org-terms-1');
  });

  test('closes prior effective boundary without mutating its snapshot and rejects unsafe scopes/plans', async () => {
    const repository = memoryRepository();
    const service = createOrganizationTermsService({ repository, idSource: { newId: () => `terms-${repository.records.length + 1}` }, clock: { now: () => '2026-10-08T00:00:00.000Z' } });
    const first = await service.setEffectiveTerms(tx(), { orgId: 'org-a', planVersion: PLAN_VERSION, effectiveAt: '2026-01-01T00:00:00.000Z', actorId: 'admin-1' });
    const originalSnapshot = first.planSnapshot.terms;
    const secondPlan = { ...PLAN_VERSION, id: 'pv-2', version: 2 };
    const second = await service.setEffectiveTerms(tx(), { orgId: 'org-a', planVersion: secondPlan, effectiveAt: '2026-07-01T00:00:00.000Z', actorId: 'admin-1' });
    expect(first.effectiveTo).toBe('2026-07-01T00:00:00.000Z');
    expect(first.planSnapshot.terms).toEqual(originalSnapshot);
    expect(second.planSnapshot.id).toBe('pv-2');
    await expect(service.setEffectiveTerms(tx('org-b'), { orgId: 'org-a', planVersion: PLAN_VERSION, effectiveAt: '2026-12-01T00:00:00.000Z', actorId: 'admin-1' })).rejects.toThrow(/transaction orgId/);
    await expect(service.setEffectiveTerms(tx(), { orgId: 'org-a', planVersion: { ...PLAN_VERSION, status: 'draft' }, effectiveAt: '2026-12-01T00:00:00.000Z', actorId: 'admin-1' })).rejects.toThrow(/published/);
    await expect(service.setEffectiveTerms(tx(), { orgId: 'org-a', planVersion: PLAN_VERSION, effectiveAt: '2025-12-01T00:00:00.000Z', actorId: 'admin-1' })).rejects.toThrow(/within the referenced/);
  });
});
