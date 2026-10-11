'use strict';

// Call provider ownership is captured when an outbound reservation is made
// so later connector edits cannot change who is charged for provider costs.
module.exports = {
  id: '2026100729_telephony_billing_ownership_snapshot',
  steps: [
    { sql: "ALTER TABLE recharge_billing_reservations ADD COLUMN telephony_owner_type VARCHAR(32) NULL", ignore: ['ER_DUP_FIELDNAME'] },
    { sql: "ALTER TABLE recharge_billing_reservations ADD COLUMN telephony_charge_scope VARCHAR(32) NULL", ignore: ['ER_DUP_FIELDNAME'] },
    { sql: "ALTER TABLE recharge_billing_reservations ADD COLUMN telephony_call_route_id VARCHAR(191) NULL", ignore: ['ER_DUP_FIELDNAME'] },
    { sql: "CREATE INDEX idx_recharge_reservation_telephony_route ON recharge_billing_reservations (telephony_call_route_id)", ignore: ['ER_DUP_KEYNAME'] },
  ],
};
