module.exports = {
  id: '2026100722_workspace_addon_purchases',
  steps: [
    { sql: `CREATE TABLE IF NOT EXISTS billing_workspace_addons (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      org_id VARCHAR(191) NOT NULL,
      workspace_id VARCHAR(191) NULL,
      member_id VARCHAR(191) NOT NULL,
      name VARCHAR(120) NOT NULL,
      industry VARCHAR(100) NOT NULL,
      branch_name VARCHAR(160) NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      monthly_units BIGINT UNSIGNED NOT NULL,
      terms_snapshot_json JSON NOT NULL,
      auto_renew TINYINT NOT NULL DEFAULT 1,
      anchor_at DATETIME(6) NULL,
      period_ends_at DATETIME(6) NULL,
      grace_ends_at DATETIME(6) NULL,
      next_action_at DATETIME(6) NOT NULL,
      created_at DATETIME(6) NOT NULL,
      updated_at DATETIME(6) NOT NULL,
      UNIQUE KEY uq_workspace_addons_org_id (org_id,id),
      UNIQUE KEY uq_workspace_addons_workspace (org_id,workspace_id),
      KEY idx_workspace_addons_due (next_action_at,id),
      KEY idx_workspace_addons_org_status (org_id,status,id),
      CONSTRAINT fk_workspace_addons_account FOREIGN KEY (org_id) REFERENCES organization_billing_accounts(org_id),
      CONSTRAINT fk_workspace_addons_workspace FOREIGN KEY (org_id,workspace_id) REFERENCES workspaces(org_id,id),
      CONSTRAINT fk_workspace_addons_member FOREIGN KEY (org_id,member_id) REFERENCES org_members(org_id,id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS billing_workspace_addon_cycles (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      org_id VARCHAR(191) NOT NULL,
      addon_id VARCHAR(191) NOT NULL,
      invoice_id VARCHAR(191) NOT NULL,
      cycle_index INT UNSIGNED NOT NULL,
      starts_at DATETIME(6) NULL,
      ends_at DATETIME(6) NULL,
      paid_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL,
      UNIQUE KEY uq_workspace_addon_cycles_sequence (org_id,addon_id,cycle_index),
      UNIQUE KEY uq_workspace_addon_cycles_invoice (org_id,invoice_id),
      CONSTRAINT fk_workspace_addon_cycles_addon FOREIGN KEY (org_id,addon_id) REFERENCES billing_workspace_addons(org_id,id),
      CONSTRAINT fk_workspace_addon_cycles_invoice FOREIGN KEY (org_id,invoice_id) REFERENCES billing_invoices(org_id,id)
    )` },
    // Existing unpaid extras get an invoice and seven days to arrange payment.
    // The default workspace is always counted within the included allowance.
    { sql: `INSERT INTO billing_workspace_addons
      (id,org_id,workspace_id,member_id,name,industry,branch_name,status,monthly_units,terms_snapshot_json,
        anchor_at,period_ends_at,grace_ends_at,next_action_at,created_at,updated_at)
      SELECT CONCAT('workspace-addon-legacy-',UUID()),o.id,w.id,
        (SELECT m.id FROM org_members m WHERE m.org_id=o.id AND COALESCE(NULLIF(m.status,''),'Active')='Active'
          ORDER BY CASE WHEN m.role IN ('Owner','Organization Admin','Super Admin') THEN 0 ELSE 1 END,m.created_at,m.id LIMIT 1),
        LEFT(w.name,120),w.industry,LEFT(w.branch_name,160),'active',
        ROUND(JSON_UNQUOTE(JSON_EXTRACT(o.settings,'$.workspacePolicy.pricing.extraWorkspaceMonthlyInr'))*100),
        JSON_OBJECT('legacyGrace',true,'policy',JSON_EXTRACT(o.settings,'$.workspacePolicy')),
        UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 7 DAY),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6)
      FROM organizations o JOIN organization_billing_accounts b ON b.org_id=o.id
      JOIN (SELECT id,org_id,name,industry,branch_name,
        ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY is_default DESC,created_at,id) AS allowance_position FROM workspaces) w ON w.org_id=o.id
      WHERE w.allowance_position>COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.settings,'$.workspacePolicy.pricing.includedWorkspaces'))+0,1)
        AND JSON_UNQUOTE(JSON_EXTRACT(o.settings,'$.workspacePolicy.pricing.extraWorkspaceMonthlyInr'))+0>0
        AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id=o.id AND COALESCE(NULLIF(m.status,''),'Active')='Active')
      ON DUPLICATE KEY UPDATE id=billing_workspace_addons.id` },
    { sql: `UPDATE workspaces w JOIN billing_workspace_addons a ON a.org_id=w.org_id AND a.workspace_id=w.id
      SET w.settings=JSON_SET(COALESCE(w.settings,JSON_OBJECT()),
        '$.billingAgreement',COALESCE(JSON_EXTRACT(w.settings,'$.billingAgreement'),JSON_OBJECT()),
        '$.billingAgreement.addonId',a.id,'$.billingAgreement.separatelyInvoiced',true)` },
  ],
};
