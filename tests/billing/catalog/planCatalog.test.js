'use strict';

const {
  normalizePlanTerms,
  normalizePlanOverrides,
  applyPlanOverrides,
  createPlanCatalogService,
} = require('../../../src/billing/modules/catalog');

const TERMS = Object.freeze({
  schemaVersion: 1,
  currency: 'INR',
  billingInterval: { unit: 'month', count: 1 },
  subscriptionPrice: { asset: 'INR', units: '1200000', scale: 2 },
  structure: {
    mode: 'same_industry',
    includedWorkspaces: 1,
    includedDistinctIndustries: 1,
    maxWorkspaces: 20,
    maxDistinctIndustries: 1,
    orgAdminWorkspaceIndustry: 'primary_only',
  },
  workspaceFees: {
    additionalWorkspace: { asset: 'INR', units: '10000', scale: 2 },
    additionalDistinctIndustry: { asset: 'INR', units: '50000', scale: 2 },
  },
  includedCredits: { asset: 'CREDITS', units: '100000', scale: 0 },
  taxes: [{ code: 'GST', rateBps: 1800, appliesTo: ['subscription', 'additional_workspace', 'additional_industry'], inclusive: false }],
  postpaid: {
    eligible: true,
    workspaceModes: ['limited'],
    organizationExposureLimit: { asset: 'INR', units: '500000', scale: 2 },
  },
  serviceAfterExpiry: { mode: 'suspend', graceSeconds: 0 },
});

function memoryRepository() {
  const plans = new Map();
  const versions = new Map();
  const key = (planId, version) => `${planId}:${version}`;
  return {
    plans,
    versions,
    async createPlanWithDraft({ plan, version }) {
      if (plans.has(plan.id) || [...plans.values()].some((item) => item.code === plan.code)) throw new Error('duplicate plan');
      plans.set(plan.id, { ...plan, status: 'draft' });
      versions.set(key(plan.id, 1), { ...version, status: 'draft', effectiveFrom: null, effectiveTo: null, publishedAt: null });
      return { plan: plans.get(plan.id), version: versions.get(key(plan.id, 1)) };
    },
    async createDraftVersion({ planId, id, terms, now }) {
      if (!plans.has(planId)) return null;
      const version = Math.max(0, ...[...versions.values()].filter((v) => v.planId === planId).map((v) => v.version)) + 1;
      const row = { id, planId, version, status: 'draft', terms, now };
      versions.set(key(planId, version), row);
      return row;
    },
    async replaceDraftTerms({ planId, version, terms }) {
      const row = versions.get(key(planId, version));
      if (!row || row.status !== 'draft') return null;
      const updated = { ...row, terms };
      versions.set(key(planId, version), updated);
      return updated;
    },
    async publishDraft({ planId, version, effectiveAt, now }) {
      const target = versions.get(key(planId, version));
      if (!target || target.status !== 'draft') return target ? { conflict: true } : null;
      const published = [...versions.values()].filter((v) => v.planId === planId && v.status === 'published');
      if (published.some((v) => v.effectiveFrom >= effectiveAt)) return { conflict: true };
      const current = published.find((v) => v.effectiveFrom < effectiveAt && (!v.effectiveTo || v.effectiveTo > effectiveAt));
      if (current) versions.set(key(planId, current.version), { ...current, effectiveTo: effectiveAt });
      const row = { ...target, status: 'published', effectiveFrom: effectiveAt, publishedAt: now };
      versions.set(key(planId, version), row);
      plans.set(planId, { ...plans.get(planId), status: 'active' });
      return row;
    },
    async getVersion({ planId, version }) { return versions.get(key(planId, version)) || null; },
    async getEffectiveVersion({ planId, at }) {
      const found = [...versions.values()].find((v) => v.planId === planId && v.status === 'published' && v.effectiveFrom <= at && (!v.effectiveTo || v.effectiveTo > at));
      return found || null;
    },
    async listPlans({ status, limit, afterId }) {
      return [...plans.values()].filter((p) => (!status || p.status === status) && (!afterId || p.id > afterId)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
    },
    async listVersions({ planId, limit, afterVersion }) {
      return [...versions.values()].filter((v) => v.planId === planId && (!afterVersion || v.version < afterVersion)).sort((a, b) => b.version - a.version).slice(0, limit);
    },
  };
}

describe('plan catalog and immutable plan versions', () => {
  test('normalizes terms as an immutable cross-module snapshot', () => {
    const terms = normalizePlanTerms(TERMS);
    expect(Object.isFrozen(terms)).toBe(true);
    expect(Object.isFrozen(terms.taxes[0])).toBe(true);
    expect(terms.structure.includedWorkspaces).toBe(1);
    expect(terms.includedCredits).toEqual(TERMS.includedCredits);
    expect(terms.taxes[0].appliesTo).toEqual(['additional_industry', 'additional_workspace', 'subscription']);
  });

  test('validates structural modes, tax applicability, and primary-industry admin rule', () => {
    expect(() => normalizePlanTerms({ ...TERMS, structure: { ...TERMS.structure, mode: 'single' } })).toThrow(/single mode/);
    expect(() => normalizePlanTerms({ ...TERMS, structure: { ...TERMS.structure, orgAdminWorkspaceIndustry: 'any' } })).toThrow(/primary_only/);
    expect(() => normalizePlanTerms({ ...TERMS, postpaid: { ...TERMS.postpaid, eligible: false } })).toThrow(/workspaceModes/);
    expect(() => normalizePlanTerms({ ...TERMS, serviceAfterExpiry: { mode: 'continue_postpaid', graceSeconds: 0 }, postpaid: { ...TERMS.postpaid, eligible: false, workspaceModes: [] } })).toThrow(/requires postpaid/);
    expect(() => normalizePlanTerms({ ...TERMS, taxes: [{ ...TERMS.taxes[0], appliesTo: ['unknown'] }] })).toThrow(/appliesTo/);
  });

  test('overrides are allowlisted, merged, and revalidated as complete effective terms', () => {
    const override = normalizePlanOverrides({ structure: { maxWorkspaces: 50 }, postpaid: { eligible: false, workspaceModes: [] } });
    const effective = applyPlanOverrides(TERMS, override);
    expect(effective.structure.maxWorkspaces).toBe(50);
    expect(effective.postpaid.eligible).toBe(false);
    expect(effective.includedCredits).toEqual(TERMS.includedCredits);
    expect(() => normalizePlanOverrides({ structure: { orgAdminWorkspaceIndustry: 'any' } })).toThrow(/primary_only/);
    expect(() => normalizePlanOverrides({ unknown: true })).toThrow(/not allowed/);
  });

  test('draft edits stop after publication and later publication preserves historical snapshots', async () => {
    const repository = memoryRepository();
    let id = 0;
    const service = createPlanCatalogService({
      repository,
      idSource: { newId: (kind) => `${kind}-${++id}` },
      clock: { now: () => '2026-10-08T00:00:00.000Z' },
    });
    const created = await service.createPlan({ code: 'team', displayName: 'Team Plan', terms: TERMS });
    const published = await service.publishDraft({ planId: created.plan.id, version: 1 });
    expect(published.status).toBe('published');
    const historical = await service.getVersion({ planId: created.plan.id, version: 1 });
    expect(await service.updateDraft({ planId: created.plan.id, version: 1, terms: { ...TERMS, subscriptionPrice: { ...TERMS.subscriptionPrice, units: '990000' } } })).toBeNull();

    const nextTerms = { ...TERMS, subscriptionPrice: { ...TERMS.subscriptionPrice, units: '990000' } };
    await service.createDraftVersion({ planId: created.plan.id, terms: nextTerms });
    const future = await service.publishDraft({ planId: created.plan.id, version: 2, effectiveFrom: '2026-11-08T00:00:00.000Z' });
    expect(future.terms.subscriptionPrice.units).toBe('990000');
    expect((await service.getVersion({ planId: created.plan.id, version: 1 })).terms.subscriptionPrice.units).toBe(historical.terms.subscriptionPrice.units);
    expect((await service.getEffectiveVersion({ planId: created.plan.id, at: '2026-10-31T00:00:00.000Z' })).version).toBe(1);
    expect((await service.getEffectiveVersion({ planId: created.plan.id, at: '2026-11-08T00:00:00.000Z' })).version).toBe(2);
    expect((await service.listPlans({ status: 'active' })).length).toBe(1);
    expect((await service.listVersions({ planId: created.plan.id })).map((item) => item.version)).toEqual([2, 1]);
  });
});
