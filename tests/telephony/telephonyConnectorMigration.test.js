'use strict';

const fs = require('fs');
const path = require('path');
const migration = require('../../src/db/migrations/2026100728-telephony-connector-foundation');
const billingOwnershipMigration = require('../../src/db/migrations/2026100729-telephony-billing-ownership-snapshot');
const fallbackMigration = require('../../src/db/migrations/2026100730-telephony-call-route-fallback-idempotency');
const callContextMigration = require('../../src/db/migrations/2026100731-telephony-call-context');

function tableSql(table) {
  return migration.steps.find(({ sql }) => new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql))?.sql || '';
}

describe('provider-independent telephony connector migration', () => {
  test('is registered after the existing migration history', () => {
    const registry = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/index.js'), 'utf8');
    expect(registry).toContain('require("./2026100727-subscription-lifecycle"), require("./2026100728-telephony-connector-foundation")');
    expect(migration.id).toBe('2026100728_telephony_connector_foundation');
  });

  test('allows multiple accounts per provider while keeping account credentials scoped and encrypted', () => {
    const accounts = tableSql('telephony_connector_accounts');
    expect(accounts).toContain('provider_key VARCHAR(64) NOT NULL');
    expect(accounts).toContain('credential_ciphertext MEDIUMTEXT NOT NULL');
    expect(accounts).toContain('owner_scope_key VARCHAR(205) GENERATED ALWAYS');
    expect(accounts).toContain('UNIQUE KEY uq_telephony_connector_scoped_provider_account (provider_key,owner_scope_key,provider_account_id)');
    expect(accounts).toContain("owner_type = 'platform' AND owner_org_id IS NULL");
    expect(accounts).toContain("owner_type = 'organization' AND owner_org_id IS NOT NULL");
  });

  test('tracks provider-neutral inventory and permits only one active assignment per number', () => {
    const numbers = tableSql('telephony_phone_numbers');
    const assignments = tableSql('telephony_number_assignments');
    expect(numbers).toContain('connector_account_id VARCHAR(191) NOT NULL');
    expect(numbers).toContain('provider_key VARCHAR(64) NOT NULL');
    expect(numbers).toContain('UNIQUE KEY uq_telephony_phone_number_e164 (phone_number_e164)');
    expect(assignments).toContain('released_at DATETIME(6) NULL');
    expect(assignments).toContain('active_phone_number_id VARCHAR(191) GENERATED ALWAYS');
    expect(assignments).toContain('UNIQUE KEY uq_telephony_assignment_active_number (active_phone_number_id)');
    expect(assignments).toContain('FOREIGN KEY (org_id,workspace_id) REFERENCES workspaces(org_id,id)');
  });

  test('stores durable call routing identity and safe call-log attribution', () => {
    const route = tableSql('telephony_call_routes');
    const aliases = tableSql('telephony_call_route_aliases');
    expect(route).toContain('connector_account_id VARCHAR(191) NOT NULL');
    expect(route).toContain('phone_number_id VARCHAR(191) NOT NULL');
    expect(route).toContain('assignment_id VARCHAR(191) NOT NULL');
    expect(route).toContain("status VARCHAR(32) NOT NULL DEFAULT 'starting'");
    expect(route).toContain('callback_secret_hash CHAR(64) NOT NULL');
    expect(aliases).toContain('UNIQUE KEY uq_telephony_route_provider_call (provider_key,provider_call_id)');
    expect(aliases).toContain('ON DELETE CASCADE');
    expect(migration.steps.filter(({ sql }) => sql.includes('ALTER TABLE call_logs ADD COLUMN telephony_')).length).toBe(5);
    expect(migration.steps.some(({ sql }) => sql.includes('CREATE INDEX idx_call_logs_telephony_connector'))).toBe(true);
  });

  test('snapshots telephony ownership on billing reservations', () => {
    expect(billingOwnershipMigration.id).toBe('2026100729_telephony_billing_ownership_snapshot');
    expect(billingOwnershipMigration.steps[0].sql).toContain('recharge_billing_reservations ADD COLUMN telephony_owner_type');
    expect(billingOwnershipMigration.steps[1].sql).toContain('recharge_billing_reservations ADD COLUMN telephony_charge_scope');
    expect(billingOwnershipMigration.steps[2].sql).toContain('recharge_billing_reservations ADD COLUMN telephony_call_route_id');
    const registry = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/index.js'), 'utf8');
    expect(registry).toContain('require("./2026100728-telephony-connector-foundation"), require("./2026100729-telephony-billing-ownership-snapshot")');
  });

  test('persists route fallback idempotency and bounded non-secret call context', () => {
    expect(fallbackMigration.steps[0].sql).toContain('fallback_call_log_id');
    expect(callContextMigration.steps[0].sql).toContain('call_context_json JSON');
    const registry = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/index.js'), 'utf8');
    expect(registry).toContain('require("./2026100729-telephony-billing-ownership-snapshot"), require("./2026100730-telephony-call-route-fallback-idempotency"), require("./2026100731-telephony-call-context")');
  });
});
