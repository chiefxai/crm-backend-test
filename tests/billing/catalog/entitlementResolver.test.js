'use strict';

const {
  resolveEntitlements,
  authorizeWorkspaceCreation,
  mergeEffectiveTerms
} = require('../../../src/billing/modules/catalog/entitlementResolver');

const EFFECTIVE_AT = '2026-10-08T12:00:00.000Z';
const planVersion = {
  id: 'plan-version-1',
  version: 3,
  terms: {
    schemaVersion: 1,
    currency: 'INR',
    billingInterval: { unit: 'month', count: 1 },
    subscriptionPrice: { asset: 'INR', units: '1000000000', scale: 6 },
    structure: {
      mode: 'same_industry',
      maxWorkspaces: 5,
      maxDistinctIndustries: 1,
      includedWorkspaces: 1,
      includedDistinctIndustries: 1,
      orgAdminWorkspaceIndustry: 'primary_only'
    },
    workspaceFees: {
      additionalWorkspace: { asset: 'INR', units: '100000000', scale: 6 },
      additionalDistinctIndustry: { asset: 'INR', units: '250000000', scale: 6 }
    },
    includedCredits: { asset: 'CREDITS', units: '2000000', scale: 0 },
    taxes: [{ code: 'GST', rateBps: 1800, appliesTo: ['subscription', 'additional_workspace', 'additional_industry'], inclusive: false }],
    postpaid: { eligible: false, workspaceModes: [], organizationExposureLimit: null },
    serviceAfterExpiry: { mode: 'suspend', graceSeconds: 0 }
  }
};

function resolve({ overrides = {}, organization = { primaryIndustryCode: 'lending' }, workspaces = [], version = planVersion, effectiveAt = EFFECTIVE_AT } = {}) {
  return resolveEntitlements({ planVersion: version, orgOverrides: overrides, organization, workspaces, effectiveAt });
}

describe('billing entitlement resolver', () => {
  test('resolves single workspace and same-industry structures with deterministic inventory', () => {
    const single = resolve({ overrides: { structure: { mode: 'single', maxWorkspaces: 1 } } });
    expect(single.terms.structure.mode).toBe('single');
    expect(single.inventory).toMatchObject({ workspaceCount: 0, distinctIndustryCount: 0, industryCodes: [], industryCounts: {}, industries: [], additionalDistinctIndustryCount: 0 });
    expect(single.inventory.sourceVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authorizeWorkspaceCreation(single, { industryCode: 'lending', actorRole: 'org_admin' })).toEqual({ allowed: true, reason: null });
    const withOne = resolve({ overrides: { structure: { mode: 'single', maxWorkspaces: 1 } }, workspaces: [{ id: 'w1', industryCode: 'lending' }] });
    expect(authorizeWorkspaceCreation(withOne, { industryCode: 'lending', actorRole: 'platform_admin' })).toMatchObject({ allowed: false, reason: 'MAX_WORKSPACES_EXCEEDED' });

    const same = resolve({ workspaces: [{ id: 'w1', industryCode: 'lending' }, { id: 'w2', industryCode: 'lending', status: 'suspended' }] });
    expect(same.inventory.workspaceCount).toBe(2);
    expect(same.inventory.distinctIndustryCount).toBe(1);
    expect(same.conflicts).toEqual([]);
  });

  test('mixed industry entitlement permits platform provisioning but keeps org-admin branches in primary industry', () => {
    const mixed = resolve({
      overrides: { structure: { mode: 'mixed_industry', maxDistinctIndustries: 3 } },
      workspaces: [{ id: 'a', industryCode: 'lending' }]
    });
    expect(authorizeWorkspaceCreation(mixed, { industryCode: 'health', actorRole: 'org_admin' })).toMatchObject({
      allowed: false, reason: 'ORG_ADMIN_PRIMARY_INDUSTRY_ONLY'
    });
    expect(authorizeWorkspaceCreation(mixed, { industryCode: 'health', actorRole: 'platform_admin' })).toEqual({ allowed: true, reason: null });
    expect(authorizeWorkspaceCreation(mixed, { industryCode: 'health', actorRole: 'member' })).toMatchObject({ allowed: false, reason: 'ACTOR_NOT_AUTHORIZED' });
  });

  test('reports downgrade conflicts against existing workspace and industry inventory', () => {
    const downgraded = resolve({
      overrides: { structure: { mode: 'same_industry', maxWorkspaces: 1 } },
      workspaces: [
        { id: 'w1', industryCode: 'lending' },
        { id: 'w2', industryCode: 'lending' },
        { id: 'w3', industryCode: 'health' }
      ]
    });
    expect(downgraded.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'STRUCTURE_MODE_CONFLICT' }),
      expect.objectContaining({ code: 'MAX_WORKSPACES_EXCEEDED', limit: 1, actual: 3 }),
      expect.objectContaining({ code: 'MAX_INDUSTRIES_EXCEEDED', limit: 1, actual: 2 })
    ]));
    expect(authorizeWorkspaceCreation(downgraded, { industryCode: 'lending', actorRole: 'platform_admin' })).toMatchObject({
      allowed: false, reason: 'EXISTING_ENTITLEMENT_CONFLICT'
    });
  });

  test('resolves explicit subscription overrides without mutating the immutable plan', () => {
    const input = JSON.parse(JSON.stringify(planVersion.terms));
    const effective = mergeEffectiveTerms(input, { structure: { maxWorkspaces: 9 }, includedCredits: { asset: 'CREDITS', units: '3000000', scale: 0 } });
    expect(effective.structure.maxWorkspaces).toBe(9);
    expect(effective.includedCredits.units).toBe('3000000');
    expect(input.structure.maxWorkspaces).toBe(5);
    expect(() => mergeEffectiveTerms(input, { unreviewedField: true })).toThrow(/overrides.unreviewedField is not allowed/);
  });

  test('carries included credits and tax treatment from the effective terms snapshot', () => {
    const resolved = resolve({ overrides: { taxes: [{ code: 'GST', rateBps: 1200, appliesTo: ['subscription'], inclusive: true }] } });
    expect(resolved.terms.includedCredits).toEqual(planVersion.terms.includedCredits);
    expect(resolved.terms.taxes).toEqual([{ code: 'GST', rateBps: 1200, appliesTo: ['subscription'], inclusive: true }]);
    expect(resolved.planVersionId).toBe('plan-version-1');
  });

  test('postpaid expiry behavior is explicit, and invalid policy combinations fail closed', () => {
    const postpaid = resolve({
      overrides: {
        postpaid: { eligible: true, workspaceModes: ['limited'], organizationExposureLimit: { asset: 'INR', units: '500000000', scale: 6 } },
        serviceAfterExpiry: { mode: 'continue_postpaid', graceSeconds: 0 }
      },
      organization: { primaryIndustryCode: 'lending', subscriptionEndsAt: '2026-10-01T00:00:00.000Z' }
    });
    expect(postpaid.serviceAccess).toMatchObject({ state: 'postpaid', allowed: true, postpaidRequired: true });

    const suspended = resolve({ organization: { primaryIndustryCode: 'lending', subscriptionEndsAt: '2026-10-01T00:00:00.000Z' } });
    expect(suspended.serviceAccess).toMatchObject({ state: 'suspended', allowed: false });
    expect(() => resolve({
      overrides: { serviceAfterExpiry: { mode: 'continue_postpaid' } },
      organization: { primaryIndustryCode: 'lending', subscriptionEndsAt: '2026-10-01T00:00:00.000Z' }
    })).toThrow(/requires postpaid eligibility/);
    const invalidPolicy = resolve({
      overrides: { serviceAfterExpiry: { mode: 'grace', graceSeconds: 86400 } },
      organization: { primaryIndustryCode: 'lending', subscriptionEndsAt: '2026-10-08T18:00:00.000Z' }
    });
    expect(invalidPolicy.serviceAccess).toMatchObject({ state: 'active', allowed: true });
  });

  test('grace policy allows service only until its exact configured boundary', () => {
    const config = {
      overrides: { serviceAfterExpiry: { mode: 'grace', graceSeconds: 3600 } },
      organization: { primaryIndustryCode: 'lending', subscriptionEndsAt: '2026-10-08T11:00:00.000Z' },
      effectiveAt: '2026-10-08T11:30:00.000Z'
    };
    expect(resolve(config).serviceAccess).toMatchObject({ state: 'grace', allowed: true });
    const atBoundary = resolve({ ...config, effectiveAt: '2026-10-08T12:00:00.000Z' });
    expect(atBoundary.serviceAccess).toMatchObject({ state: 'suspended', allowed: false });
  });
});
