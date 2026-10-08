'use strict';

const { createTransactionContext } = require('../../../src/billing/kernel/transactionContext');
const { createMysqlOrganizationTermsRepository } = require('../../../src/billing/modules/catalog');

const terms = {
  schemaVersion: 1,
  currency: 'INR',
  billingInterval: { unit: 'month', count: 1 },
  subscriptionPrice: { asset: 'INR', units: '1000000', scale: 6 },
  structure: { mode: 'same_industry', includedWorkspaces: 1, includedDistinctIndustries: 1, maxWorkspaces: 10, maxDistinctIndustries: 1, orgAdminWorkspaceIndustry: 'primary_only' },
  workspaceFees: { additionalWorkspace: { asset: 'INR', units: '0', scale: 6 }, additionalDistinctIndustry: { asset: 'INR', units: '0', scale: 6 } },
  includedCredits: { asset: 'CREDITS', units: '1000', scale: 0 }, taxes: [],
  postpaid: { eligible: false, workspaceModes: [], organizationExposureLimit: null },
  serviceAfterExpiry: { mode: 'suspend', graceSeconds: 0 },
};
function setup(existing = [], persistedPlan = null) {
  const calls = [];
  const databasePlan = persistedPlan || {
    id: 'pv-2', plan_id: 'plan-1', version: 2, status: 'published', terms_json: JSON.stringify(terms),
    effective_from: new Date('2026-01-01T00:00:00.000Z'), effective_to: null,
  };
  const context = createTransactionContext({
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT org_id FROM organization_billing_accounts')) return [{ org_id: 'org-1' }];
      if (sql.includes('FROM billing_plan_versions WHERE plan_id=? AND version=? FOR UPDATE')) return [databasePlan];
      if (sql.includes('FROM organization_billing_terms') && sql.includes('ORDER BY version FOR UPDATE')) return existing;
      if (sql.startsWith('UPDATE organization_billing_terms SET effective_to=')) return { affectedRows: 1 };
      if (sql.startsWith('INSERT INTO organization_billing_terms')) return { affectedRows: 1 };
      if (sql.includes('FROM organization_billing_terms') && sql.includes('effective_from<=?')) return [];
      return { affectedRows: 0 };
    },
  }, { orgId: 'org-1', operationId: 'op-1', billingAccountVersion: 1 });
  return { repository: createMysqlOrganizationTermsRepository(), tx: context, calls };
}

const planVersion = { id: 'pv-2', planId: 'plan-1', version: 2, status: 'published', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, terms };

describe('MySQL organization terms repository', () => {
  test('locks organization scope, closes predecessor at boundary, and persists immutable plan/effective snapshots', async () => {
    const prior = { id: 'terms-1', version: 1, effective_from: new Date('2026-01-01T00:00:00.000Z'), effective_to: null };
    const { repository, tx: context, calls } = setup([prior]);
    const created = await repository.insertEffectiveTerms(context, {
      id: 'terms-2', orgId: 'org-1', planVersion, overrides: { structure: { maxWorkspaces: 25 } },
      effectiveTerms: { ...terms, structure: { ...terms.structure, maxWorkspaces: 25 } },
      effectiveAt: '2026-07-01T00:00:00.000Z', actorId: 'platform-1', changeReason: 'Expanded', now: '2026-06-30T00:00:00.000Z',
    });
    expect(created.version).toBe(2);
    expect(created.planSnapshot).toMatchObject({ id: 'pv-2', planId: 'plan-1', version: 2, terms });
    expect(calls[0].sql).toContain('organization_billing_accounts');
    const close = calls.find(({ sql }) => sql.startsWith('UPDATE organization_billing_terms SET effective_to='));
    expect(close.params[0]).toBe('2026-07-01T00:00:00.000Z');
    const insert = calls.find(({ sql }) => sql.startsWith('INSERT INTO organization_billing_terms'));
    const snapshot = JSON.parse(insert.params[6]);
    expect(snapshot.planVersion).toMatchObject({ id: 'pv-2', planId: 'plan-1', version: 2, terms });
    expect(snapshot.effectiveTerms.structure.maxWorkspaces).toBe(25);
    expect(JSON.parse(insert.params[7])).toEqual({ structure: { maxWorkspaces: 25 } });
  });

  test('rejects a new effective version that overlaps a scheduled version', async () => {
    const existing = [{ id: 'future', version: 3, effective_from: new Date('2026-08-01T00:00:00.000Z'), effective_to: null }];
    const { repository, tx: context, calls } = setup(existing);
    await expect(repository.insertEffectiveTerms(context, {
      id: 'terms-2', orgId: 'org-1', planVersion, overrides: {}, effectiveTerms: terms,
      effectiveAt: '2026-07-01T00:00:00.000Z', actorId: 'platform-1', now: '2026-06-30T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'BILLING_VERSION_CONFLICT' });
    expect(calls.some(({ sql }) => sql.startsWith('UPDATE organization_billing_terms'))).toBe(false);
    expect(calls.some(({ sql }) => sql.startsWith('INSERT INTO organization_billing_terms'))).toBe(false);
  });

  test('rejects forged plan identity before writing organization terms', async () => {
    const { repository, tx: context, calls } = setup();
    await expect(repository.insertEffectiveTerms(context, {
      id: 'terms-2', orgId: 'org-1', planVersion: { ...planVersion, id: 'forged-plan-version-id' }, overrides: {}, effectiveTerms: terms,
      effectiveAt: '2026-07-01T00:00:00.000Z', actorId: 'platform-1', now: '2026-06-30T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'BILLING_VERSION_CONFLICT' });
    expect(calls.some(({ sql }) => sql.startsWith('SELECT id,plan_id,version,status,terms_json,effective_from,effective_to'))).toBe(true);
    expect(calls.some(({ sql }) => sql.startsWith('INSERT INTO organization_billing_terms'))).toBe(false);
  });

  test('rejects a stale published plan window after another version has superseded it', async () => {
    const endedPlan = {
      id: 'pv-2', plan_id: 'plan-1', version: 2, status: 'published', terms_json: JSON.stringify(terms),
      effective_from: new Date('2026-01-01T00:00:00.000Z'), effective_to: new Date('2026-07-01T00:00:00.000Z'),
    };
    const { repository, tx: context, calls } = setup([], endedPlan);
    await expect(repository.insertEffectiveTerms(context, {
      id: 'terms-3', orgId: 'org-1', planVersion, overrides: {}, effectiveTerms: terms,
      effectiveAt: '2026-08-01T00:00:00.000Z', actorId: 'platform-1', now: '2026-07-31T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'BILLING_VERSION_CONFLICT' });
    expect(calls.some(({ sql }) => sql.startsWith('INSERT INTO organization_billing_terms'))).toBe(false);
  });
});
