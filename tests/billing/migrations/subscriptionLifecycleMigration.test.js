'use strict';

const fs = require('fs');
const path = require('path');
const migration = require('../../../src/db/migrations/2026100727-subscription-lifecycle');
const { BILLING_TABLES, BILLING_ORG_TABLES, WORKSPACE_TABLES } = require('../../../src/workspaces/tables');

function sqlFor(table) {
  return migration.steps.find((step) => new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(step.sql))?.sql || '';
}

describe('subscription lifecycle migration', () => {
  test('is registered after the existing immutable migration history', () => {
    const registry = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/index.js'), 'utf8');
    expect(registry).toContain('require("./2026100726-workspace-member-management"), require("./2026100727-subscription-lifecycle")');
    expect(migration.id).toBe('2026100727_subscription_lifecycle');
  });

  test('registers only organization-owned lifecycle tables outside generic workspace CRUD', () => {
    const created = migration.steps.flatMap(({ sql }) => [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gi)].map((match) => match[1]));
    expect(created).toHaveLength(4);
    for (const table of created) {
      expect(BILLING_TABLES.has(table)).toBe(true);
      expect(BILLING_ORG_TABLES.has(table)).toBe(true);
      expect(WORKSPACE_TABLES.has(table)).toBe(false);
    }
  });

  test('separates billing access cause from other suspensions and keeps the computed deadline explicit', () => {
    const sql = sqlFor('organization_subscriptions');
    expect(sql).toContain('billing_access_state VARCHAR(32)');
    expect(sql).toContain('billing_suspension_cause VARCHAR(64)');
    expect(sql).toContain('restriction_deadline DATETIME(6)');
    expect(sql).toContain('access_policy_json JSON NOT NULL');
    expect(sql).not.toMatch(/manual_suspended|security_suspended/i);
  });

  test('links periods to immutable quote, plan-version and payment records with tenant-scoped keys', () => {
    const sql = sqlFor('billing_subscription_period_links');
    expect(sql).toContain("period_state VARCHAR(32) NOT NULL DEFAULT 'awaiting_payment'");
    expect(sql).toContain('UNIQUE KEY uq_subscription_period_links_quote_purpose (org_id,quote_id,purpose)');
    expect(sql).toContain('FOREIGN KEY (org_id,period_id) REFERENCES billing_periods(org_id,id)');
    expect(sql).toContain('FOREIGN KEY (org_id,quote_id) REFERENCES billing_quotes(org_id,id)');
    expect(sql).toContain('FOREIGN KEY (org_id,payment_request_id) REFERENCES billing_payment_requests(org_id,id)');
    expect(sql).toContain('FOREIGN KEY (plan_id,plan_version) REFERENCES billing_plan_versions(plan_id,version)');
  });

  test('stores one grace request per expiring period and append-only, sequenced decisions', () => {
    const requests = sqlFor('billing_subscription_grace_requests');
    const decisions = sqlFor('billing_subscription_grace_decisions');
    expect(requests).toContain('UNIQUE KEY uq_subscription_grace_one_per_period (org_id,period_id)');
    expect(requests).toContain('requested_until DATETIME(6) NOT NULL');
    expect(requests).toContain('justification VARCHAR(2000) NOT NULL');
    expect(requests).toContain('granted_until DATETIME(6) NULL');
    expect(decisions).toContain('UNIQUE KEY uq_subscription_grace_decisions_sequence (org_id,grace_request_id,sequence_no)');
    expect(decisions).toContain('decided_by VARCHAR(191) NOT NULL');
    expect(decisions).toContain('reason VARCHAR(2000) NOT NULL');
    expect(decisions).toContain('expected_version BIGINT UNSIGNED NOT NULL');
    expect(decisions).not.toMatch(/ON DELETE CASCADE/i);
  });
});
