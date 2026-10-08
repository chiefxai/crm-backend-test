// Attribute variable usage to the workspace that placed the call. The
// organization still owns the wallet and invoice; workspace_id supports
// itemized usage and workspace spending limits.
const usageTables = ['ai_session_usage', 'call_billing_records'];
module.exports = {
  id: '2026100711_workspace_billing',
  steps: [
    ...usageTables.flatMap((table) => [
      { sql: `ALTER TABLE \`${table}\` ADD COLUMN workspace_id VARCHAR(191) NULL`, ignore: ['ER_DUP_FIELDNAME'] },
      { sql: `UPDATE \`${table}\` usage_row LEFT JOIN call_logs call_row
        ON call_row.org_id=usage_row.org_id AND call_row.id=usage_row.call_id
        SET usage_row.workspace_id=COALESCE(call_row.workspace_id,usage_row.org_id)
        WHERE usage_row.workspace_id IS NULL` },
      { sql: `CREATE INDEX idx_${table}_org_workspace_created ON \`${table}\` (org_id,workspace_id,created_at)`, ignore: ['ER_DUP_KEYNAME'] },
    ]),
    { sql: 'ALTER TABLE recharge_billing_reservations ADD COLUMN workspace_id VARCHAR(191) NULL', ignore: ['ER_DUP_FIELDNAME'] },
    { sql: 'ALTER TABLE recharge_billing_reservations ADD COLUMN workspace_estimated_amount_inr DECIMAL(14,2) NULL', ignore: ['ER_DUP_FIELDNAME'] },
    { sql: 'ALTER TABLE recharge_billing_reservations ADD COLUMN billing_method VARCHAR(40) NULL', ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `UPDATE recharge_billing_reservations reservation_row LEFT JOIN call_logs call_row
      ON call_row.org_id=reservation_row.org_id AND call_row.provider_call_sid=reservation_row.provider_call_sid
      SET reservation_row.workspace_id=COALESCE(call_row.workspace_id,reservation_row.org_id)
      WHERE reservation_row.workspace_id IS NULL` },
    { sql: 'CREATE INDEX idx_recharge_reservations_workspace_status ON recharge_billing_reservations (org_id,workspace_id,status)', ignore: ['ER_DUP_KEYNAME'] },
  ],
};
