'use strict';

// Separates platform ownership/allocation to an organization from the
// organization's later workspace assignment.
module.exports = {
  id: '2026100732_telephony_number_org_allocations',
  steps: [
    { sql: `CREATE TABLE IF NOT EXISTS telephony_number_allocations (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      phone_number_id VARCHAR(191) NOT NULL,
      org_id VARCHAR(191) NOT NULL,
      allocated_by VARCHAR(191) NULL,
      allocated_at DATETIME(6) NOT NULL,
      released_by VARCHAR(191) NULL,
      released_at DATETIME(6) NULL,
      release_reason VARCHAR(1000) NULL,
      active_phone_number_id VARCHAR(191) GENERATED ALWAYS AS (CASE WHEN released_at IS NULL THEN phone_number_id ELSE NULL END) STORED,
      UNIQUE KEY uq_telephony_allocation_active_number (active_phone_number_id),
      KEY idx_telephony_allocation_org (org_id,released_at,allocated_at),
      CONSTRAINT fk_telephony_allocation_phone FOREIGN KEY (phone_number_id) REFERENCES telephony_phone_numbers(id),
      CONSTRAINT fk_telephony_allocation_org FOREIGN KEY (org_id) REFERENCES organizations(id)
    )` },
    // Retain existing platform number assignments as organization allocations
    // so tenants created before this split keep access to their numbers.
    { sql: `INSERT INTO telephony_number_allocations
      (id,phone_number_id,org_id,allocated_by,allocated_at)
      SELECT UUID(), assignment.phone_number_id, assignment.org_id, assignment.assigned_by, assignment.assigned_at
      FROM telephony_number_assignments assignment
      INNER JOIN telephony_phone_numbers number ON number.id=assignment.phone_number_id
      INNER JOIN telephony_connector_accounts account ON account.id=number.connector_account_id
      WHERE assignment.released_at IS NULL AND account.owner_type='platform'
        AND NOT EXISTS (SELECT 1 FROM telephony_number_allocations active
          WHERE active.phone_number_id=assignment.phone_number_id AND active.released_at IS NULL)` },
  ],
};
