'use strict';

// Repair platform-owned phone numbers whose organization was deleted before
// deletion cleanup reset their inventory status. Also retire dangling active
// ownership rows when an older schema permitted them to outlive the org.
module.exports = {
  id: '2026100734_release_orphaned_telephony_numbers',
  steps: [
    { sql: `UPDATE telephony_number_allocations allocation
              LEFT JOIN organizations organization ON organization.id=allocation.org_id
               SET allocation.released_at=UTC_TIMESTAMP(6),
                   allocation.release_reason='Organization deleted'
             WHERE allocation.released_at IS NULL AND organization.id IS NULL` },
    { sql: `UPDATE telephony_number_assignments assignment
              LEFT JOIN organizations organization ON organization.id=assignment.org_id
               SET assignment.released_at=UTC_TIMESTAMP(6),
                   assignment.release_reason='Organization deleted'
             WHERE assignment.released_at IS NULL AND organization.id IS NULL` },
    { sql: `UPDATE telephony_phone_numbers number
              INNER JOIN telephony_connector_accounts account
                ON account.id=number.connector_account_id
               SET number.inventory_status='available',number.updated_at=UTC_TIMESTAMP(6)
             WHERE account.owner_type='platform'
               AND number.inventory_status IN ('allocated','assigned')
               AND NOT EXISTS (
                 SELECT 1 FROM telephony_number_allocations allocation
                  WHERE allocation.phone_number_id=number.id AND allocation.released_at IS NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM telephony_number_assignments assignment
                  WHERE assignment.phone_number_id=number.id AND assignment.released_at IS NULL
               )` },
  ],
};
