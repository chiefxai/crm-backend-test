// Separate organization pool and system-clearing accounts by explicit purpose.
// Keep this additive: migration 0713 may already be registered/applied on some
// environments, and its historical checksum must remain stable.
module.exports = {
  id: '2026100715_billing_credit_account_purpose',
  steps: [
    {
      sql: `ALTER TABLE billing_credit_accounts
        ADD COLUMN account_purpose VARCHAR(32) NOT NULL DEFAULT 'pool' AFTER account_type`,
      ignore: ['ER_DUP_FIELDNAME'],
    },
    {
      sql: `ALTER TABLE billing_credit_accounts DROP INDEX uq_billing_credit_account_owner`,
      ignore: ['ER_CANT_DROP_FIELD_OR_KEY'],
    },
    {
      sql: `ALTER TABLE billing_credit_accounts
        ADD UNIQUE KEY uq_billing_credit_account_owner_purpose
        (org_id,account_type,owner_id,account_purpose,asset,scale)`,
      ignore: ['ER_DUP_KEYNAME'],
    },
  ],
};
