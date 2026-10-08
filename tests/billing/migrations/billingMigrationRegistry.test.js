'use strict';

const fs = require('fs');
const path = require('path');
const foundation = require('../../../src/db/migrations/2026100712-billing-foundation');
const credits = require('../../../src/db/migrations/2026100713-billing-credit-allocation');
const operations = require('../../../src/db/migrations/2026100714_billing_operations');
const {
  WORKSPACE_TABLES,
  BILLING_TABLES,
  BILLING_PLATFORM_TABLES,
  BILLING_ORG_TABLES,
  BILLING_WORKSPACE_READ_RULES,
} = require('../../../src/workspaces/tables');

function createdTables(migration) {
  return migration.steps.flatMap((step) => [...step.sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gi)].map((match) => match[1]));
}

describe('billing schema registration and ownership inventory', () => {
  test('registers billing migrations in FK dependency order after prior workspace migrations', () => {
    const registrySource = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/index.js'), 'utf8');
    const ids = [...registrySource.matchAll(/require\(["']\.\/(\d{10,}[-_][^"']+)["']\)/g)].map((match) => match[1]);
    const legacyWorkspaceBilling = '2026100711-workspace-billing';
    const foundationPath = '2026100712-billing-foundation';
    const creditPath = '2026100713-billing-credit-allocation';
    const operationsPath = '2026100714_billing_operations';
    expect(ids.indexOf(legacyWorkspaceBilling)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(foundationPath)).toBe(ids.indexOf(legacyWorkspaceBilling) + 1);
    expect(ids.indexOf(creditPath)).toBe(ids.indexOf(foundationPath) + 1);
    expect(ids.indexOf(operationsPath)).toBe(ids.indexOf(creditPath) + 1);
  });

  test('accounts for every new billing table without sending billing tables through generic workspace CRUD', () => {
    const schemaTables = [...createdTables(foundation), ...createdTables(credits), ...createdTables(operations)];
    expect(new Set(schemaTables).size).toBe(schemaTables.length);
    expect(new Set(schemaTables)).toEqual(BILLING_TABLES);
    expect(BILLING_PLATFORM_TABLES.size + BILLING_ORG_TABLES.size).toBe(BILLING_TABLES.size);
    for (const table of BILLING_TABLES) expect(WORKSPACE_TABLES.has(table)).toBe(false);
  });

  test('defines workspace read filtering for every workspace-relevant billing projection', () => {
    for (const [table, rule] of Object.entries(BILLING_WORKSPACE_READ_RULES)) {
      expect(BILLING_ORG_TABLES.has(table)).toBe(true);
      expect(Object.keys(rule).length).toBe(1);
      expect(typeof (rule.column || rule.via)).toBe('string');
      expect(rule.column || rule.via).toBeTruthy();
    }
    expect(BILLING_WORKSPACE_READ_RULES.billing_usage_events.column).toBe('workspace_id');
    expect(BILLING_WORKSPACE_READ_RULES.billing_credit_positions.via).toContain('billing_credit_accounts');
  });
});
