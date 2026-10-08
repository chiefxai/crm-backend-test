'use strict';

const migration = require('../../../src/db/migrations/2026100713-billing-credit-allocation');

describe('billing credit and allocation migration', () => {
  const sql = migration.steps.map((step) => step.sql).join('\n');

  test('creates the assigned additive schema and references the foundation tables', () => {
    expect(migration.id).toBe('2026100713_billing_credit_allocation');
    for (const table of [
      'billing_credit_grants',
      'billing_credit_accounts',
      'billing_credit_positions',
      'billing_journals',
      'billing_journal_lines',
      'billing_allocation_rule_versions',
      'billing_allocation_runs',
      'billing_usage_events',
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
    }
    expect(sql).toContain('REFERENCES billing_periods(org_id,id)');
    expect(sql).toContain('REFERENCES billing_payment_requests(org_id,id)');
    expect(sql).toContain('REFERENCES workspaces(org_id,id)');
  });

  test('keeps credit provenance, double-entry operation identity, and resumable allocation manifests', () => {
    expect(sql).toContain('UNIQUE KEY uq_billing_credit_grant_source (org_id,source_type,source_id,source_event_key)');
    expect(sql).toContain('UNIQUE KEY uq_billing_journal_operation (org_id,operation_id)');
    expect(sql).toContain('UNIQUE KEY uq_billing_credit_position_grant_account (org_id,grant_id,account_id)');
    expect(sql).toContain('UNIQUE KEY uq_billing_credit_position_asset (org_id,id,asset,scale)');
    expect(sql).toContain('manifest_json JSON NOT NULL');
    expect(sql).toContain('manifest_checksum CHAR(64) NOT NULL');
    expect(sql).toContain('applied_units BIGINT NOT NULL DEFAULT 0');
  });

  test('uses explicit integer amount assets and restricts financial history deletion', () => {
    expect(sql).toContain('amount_units BIGINT NOT NULL');
    expect(sql).toContain('asset VARCHAR(32) NOT NULL');
    expect(sql).toContain('scale TINYINT UNSIGNED NOT NULL');
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql.match(/ON DELETE RESTRICT/g).length).toBeGreaterThanOrEqual(15);
  });
});
