'use strict';

module.exports = {
  id: '2026100717_billing_payment_decision_evidence',
  steps: [
    { sql: `ALTER TABLE billing_payment_decisions ADD COLUMN request_version BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER sequence_no`, ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `ALTER TABLE billing_payment_decisions ADD COLUMN received_amount_units BIGINT NULL AFTER reason`, ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `ALTER TABLE billing_payment_decisions ADD COLUMN received_asset VARCHAR(32) NULL AFTER received_amount_units`, ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `ALTER TABLE billing_payment_decisions ADD COLUMN received_scale TINYINT UNSIGNED NULL AFTER received_asset`, ignore: ['ER_DUP_FIELDNAME'] },
  ],
};
