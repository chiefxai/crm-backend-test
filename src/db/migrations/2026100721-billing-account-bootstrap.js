// Repair organizations with no legacy wallet balance. Recharge-based accounts
// with ledger activity still require a separately reconciled migration.
module.exports = {
  id: '2026100721_billing_account_bootstrap',
  steps: [{ sql: `INSERT INTO organization_billing_accounts
    (org_id,fallback_mode,postpaid_eligible,timezone,status,created_at,updated_at)
    SELECT o.id,
      CASE WHEN o.billing_method='recharge_based' THEN 'prepaid' ELSE 'postpaid' END,
      0,'UTC','active',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6)
    FROM organizations o
    WHERE NOT EXISTS (SELECT 1 FROM organization_billing_accounts a WHERE a.org_id=o.id)
      AND COALESCE(o.recharge_balance_inr,0)=0
      AND COALESCE(o.recharge_reserved_inr,0)=0
      AND (COALESCE(o.billing_method,'pay_as_you_go')<>'recharge_based'
        OR (NOT EXISTS (SELECT 1 FROM billing_ledger_entries l WHERE l.org_id=o.id)
          AND NOT EXISTS (SELECT 1 FROM recharge_billing_reservations r WHERE r.org_id=o.id)))` }],
};
