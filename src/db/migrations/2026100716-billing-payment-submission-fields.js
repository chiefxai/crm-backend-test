'use strict';

module.exports = {
  id: '2026100716_billing_payment_submission_fields',
  steps: [
    { sql: `ALTER TABLE billing_payment_requests ADD COLUMN invoice_id VARCHAR(191) NULL AFTER period_id`, ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `ALTER TABLE billing_payment_requests ADD COLUMN proof_sha256 CHAR(64) NULL AFTER proof_object_key`, ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `ALTER TABLE billing_payment_requests ADD COLUMN proof_content_type VARCHAR(64) NULL AFTER proof_sha256`, ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `ALTER TABLE billing_payment_requests ADD COLUMN payer_note VARCHAR(2000) NULL AFTER submitted_by`, ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `ALTER TABLE billing_payment_requests ADD KEY idx_billing_payment_requests_invoice (org_id,invoice_id,status)`, ignore: ['ER_DUP_KEYNAME'] },
    { sql: `ALTER TABLE billing_payment_requests ADD CONSTRAINT fk_billing_payment_requests_invoice FOREIGN KEY (org_id,invoice_id) REFERENCES billing_invoices(org_id,id)`, ignore: ['ER_FK_DUP_NAME'] },
    { sql: `CREATE TABLE IF NOT EXISTS billing_payment_proof_versions (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      org_id VARCHAR(191) NOT NULL,
      payment_request_id VARCHAR(191) NOT NULL,
      version INT UNSIGNED NOT NULL,
      object_key VARCHAR(512) NOT NULL,
      proof_sha256 CHAR(64) NOT NULL,
      content_type VARCHAR(64) NOT NULL,
      submitted_by VARCHAR(191) NOT NULL,
      submitted_at DATETIME(6) NOT NULL,
      UNIQUE KEY uq_billing_payment_proof_versions_sequence (org_id,payment_request_id,version),
      KEY idx_billing_payment_proof_versions_hash (org_id,proof_sha256),
      CONSTRAINT fk_billing_payment_proof_versions_request FOREIGN KEY (org_id,payment_request_id)
        REFERENCES billing_payment_requests(org_id,id)
    )` },
  ],
};
