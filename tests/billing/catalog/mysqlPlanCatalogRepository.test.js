'use strict';

const { createMysqlPlanCatalogRepository } = require('../../../src/billing/modules/catalog');
const terms = {
  schemaVersion: 1,
  currency: 'INR',
  billingInterval: { unit: 'month', count: 1 },
  subscriptionPrice: { asset: 'INR', units: '1000000', scale: 6 },
  structure: { mode: 'single', includedWorkspaces: 1, includedDistinctIndustries: 1, maxWorkspaces: 1, maxDistinctIndustries: 1, orgAdminWorkspaceIndustry: 'primary_only' },
  workspaceFees: { additionalWorkspace: { asset: 'INR', units: '0', scale: 6 }, additionalDistinctIndustry: { asset: 'INR', units: '0', scale: 6 } },
  includedCredits: { asset: 'CREDITS', units: '1000', scale: 0 },
  taxes: [],
  postpaid: { eligible: false, workspaceModes: [], organizationExposureLimit: null },
  serviceAfterExpiry: { mode: 'suspend', graceSeconds: 0 },
};

function harness({ versionStatus = 'draft', activeVersion = null } = {}) {
  const statements = [];
  const connection = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql === 'START TRANSACTION' || sql === 'COMMIT' || sql === 'ROLLBACK') return { affectedRows: 0 };
      if (sql.startsWith('SELECT id,status FROM billing_plan_versions')) return [{ id: versionStatus === 'draft' ? 'v2' : 'v1', status: versionStatus }];
      if (sql.startsWith('SELECT id FROM billing_plans')) return [{ id: 'p1' }];
      if (sql.includes("status='published' AND effective_from>=?")) return [];
      if (sql.includes("status='published' AND effective_from<?")) return activeVersion ? [{ id: activeVersion }] : [];
      if (sql.startsWith('UPDATE billing_plan_versions SET effective_to=')) return { affectedRows: 1 };
      if (sql.startsWith("UPDATE billing_plan_versions SET status='published'")) return { affectedRows: 1 };
      if (sql.startsWith('UPDATE billing_plans SET status=')) return { affectedRows: 1 };
      if (sql.startsWith('SELECT id,plan_id,version,status,terms_json,effective_from,effective_to,published_at FROM billing_plan_versions WHERE id=')) {
        return [{ id: 'v2', plan_id: 'p1', version: 2, status: 'published', terms_json: '{}', effective_from: params[0], effective_to: null, published_at: params[1] }];
      }
      return { affectedRows: 1 };
    },
    release() {},
  };
  const repository = createMysqlPlanCatalogRepository({ pool: { connect: async () => connection } });
  return { repository, statements };
}

describe('MySQL plan catalog immutability boundary', () => {
  test('new draft persists its configured billing interval instead of assuming monthly', async () => {
    const { repository, statements } = harness();
    const annualTerms = { ...terms, billingInterval: { unit: 'year', count: 2 } };
    await repository.createPlanWithDraft({
      plan: { id: 'p1', code: 'annual', displayName: 'Annual', now: '2026-10-08T00:00:00.000Z' },
      version: { id: 'v1', planId: 'p1', version: 1, terms: annualTerms, now: '2026-10-08T00:00:00.000Z' },
    });
    const insert = statements.find(({ sql }) => sql.includes('INSERT INTO billing_plan_versions'));
    expect(insert.params[11]).toBe('year');
    expect(insert.params[12]).toBe(2);
  });

  test('published plan version cannot be edited', async () => {
    const { repository, statements } = harness({ versionStatus: 'published' });
    const result = await repository.replaceDraftTerms({ planId: 'p1', version: 1, terms, now: '2026-10-08T00:00:00.000Z' });
    expect(result).toBeNull();
    expect(statements.some(({ sql }) => sql.startsWith('UPDATE billing_plan_versions'))).toBe(false);
    expect(statements.at(-1).sql).toBe('COMMIT');
  });

  test('publishing a new version only closes the prior effective window and leaves its terms intact', async () => {
    const { repository, statements } = harness({ versionStatus: 'draft', activeVersion: 'v1' });
    const result = await repository.publishDraft({
      planId: 'p1', version: 2, effectiveAt: '2026-11-08T00:00:00.000Z', now: '2026-10-08T00:00:00.000Z',
    });
    expect(result.status).toBe('published');
    const closePrior = statements.find(({ sql }) => sql.startsWith('UPDATE billing_plan_versions SET effective_to='));
    expect(closePrior.params[0]).toBe('2026-11-08T00:00:00.000Z');
    expect(statements.some(({ sql }) => sql.startsWith('UPDATE billing_plan_versions') && sql.includes('terms_json'))).toBe(false);
    expect(statements.findIndex(({ sql }) => sql.startsWith('UPDATE billing_plan_versions SET effective_to='))
      ).toBeLessThan(statements.findIndex(({ sql }) => sql.startsWith("UPDATE billing_plan_versions SET status='published'")));
  });
});
