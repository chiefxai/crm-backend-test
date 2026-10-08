'use strict';

module.exports = {
  id: '2026100718_billing_lifecycle_scan_indexes',
  steps: [
    { sql: `ALTER TABLE billing_periods ADD KEY idx_billing_periods_due_activation (period_kind,status,starts_at,ends_at,org_id,id)`, ignore: ['ER_DUP_KEYNAME'] },
    { sql: `ALTER TABLE billing_periods ADD KEY idx_billing_periods_due_renewal (period_kind,status,ends_at,org_id,id)`, ignore: ['ER_DUP_KEYNAME'] },
    { sql: `ALTER TABLE billing_payment_fulfillments ADD KEY idx_billing_payment_fulfillment_period (fulfillment_kind,target_id,org_id,payment_request_id)`, ignore: ['ER_DUP_KEYNAME'] },
    { sql: `ALTER TABLE billing_credit_grants ADD KEY idx_billing_credit_grants_expiry_scan (status,expires_at,org_id,id)`, ignore: ['ER_DUP_KEYNAME'] },
  ],
};
