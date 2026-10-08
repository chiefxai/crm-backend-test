'use strict';

const migration = require('../../../src/db/migrations/2026100714_billing_operations');

describe('billing operations migration', () => {
  const sqlByTable = new Map(migration.steps.map((step) => {
    const match = step.sql.match(/CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)/i);
    return [match?.[1], step.sql];
  }));

  test('is ordered after foundation and credit migrations and creates the full operations schema', () => {
    expect(migration.id).toBe('2026100714_billing_operations');
    expect([...sqlByTable.keys()]).toEqual([
      'billing_command_operations',
      'billing_outbox',
      'billing_consumer_inbox',
      'billing_reservations',
      'billing_reservation_lines',
      'billing_postpaid_accounts',
      'billing_postpaid_period_totals',
      'billing_postpaid_journals',
      'billing_invoices',
      'billing_invoice_lines',
      'billing_invoice_payments',
      'billing_notification_policies',
      'billing_contacts',
      'billing_alert_states',
      'billing_notifications',
      'billing_notification_recipients',
      'billing_notification_deliveries',
    ]);
    for (const sql of sqlByTable.values()) {
      expect(sql).toMatch(/org_id VARCHAR\(191\) NOT NULL/);
      expect(sql).toMatch(/REFERENCES organization_billing_accounts\(org_id\)/);
      expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    }
  });

  test('supports idempotent processing, fenced claims and tenant ownership on financial references', () => {
    expect(sqlByTable.get('billing_command_operations')).toMatch(/UNIQUE KEY uq_billing_command_operations_key \(org_id,idempotency_key\)/);
    expect(sqlByTable.get('billing_outbox')).toMatch(/fencing_token BIGINT UNSIGNED/);
    expect(sqlByTable.get('billing_outbox')).toMatch(/idx_billing_outbox_partition_claim/);
    expect(sqlByTable.get('billing_consumer_inbox')).toMatch(/UNIQUE KEY uq_billing_consumer_inbox_event \(org_id,consumer_key,event_id\)/);
    expect(sqlByTable.get('billing_reservation_lines')).toMatch(/FOREIGN KEY \(org_id,credit_position_id,asset,scale\)/);
    expect(sqlByTable.get('billing_reservation_lines')).toMatch(/REFERENCES billing_credit_positions\(org_id,id,asset,scale\)/);
    expect(sqlByTable.get('billing_reservation_lines')).toMatch(/FOREIGN KEY \(org_id,credit_grant_id,asset,scale\)/);
    expect(sqlByTable.get('billing_reservation_lines')).toMatch(/REFERENCES billing_periods\(org_id,id\)/);
  });

  test('persists workspace invoice snapshots, verified recipient state and per-channel deduplication', () => {
    expect(sqlByTable.get('billing_invoice_lines')).toMatch(/workspace_snapshot_json JSON/);
    expect(sqlByTable.get('billing_contacts')).toMatch(/verification_token_hash/);
    expect(sqlByTable.get('billing_notification_recipients')).toMatch(/verification_state VARCHAR/);
    expect(sqlByTable.get('billing_notification_recipients')).toMatch(/read_at DATETIME\(6\)/);
    expect(sqlByTable.get('billing_notification_deliveries')).toMatch(/UNIQUE KEY uq_billing_notification_deliveries_once \(org_id,notification_id,recipient_id,channel\)/);
  });
});
