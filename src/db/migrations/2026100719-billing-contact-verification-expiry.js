'use strict';

module.exports = {
  id: '2026100719_billing_contact_verification_expiry',
  steps: [
    { sql: `ALTER TABLE billing_contacts ADD COLUMN verification_expires_at DATETIME(6) NULL AFTER verification_token_hash`, ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `ALTER TABLE billing_contacts ADD KEY idx_billing_contacts_verification (org_id,status,verification_expires_at)`, ignore: ['ER_DUP_KEYNAME'] },
  ],
};
