'use strict';

// Provider-independent persistence for configured telephony accounts, their
// number inventory, and organization/workspace assignment history. This is an
// additive foundation: it intentionally does not migrate or reinterpret any
// existing provider channel records.
module.exports = {
  id: '2026100728_telephony_connector_foundation',
  steps: [
    { sql: `CREATE TABLE IF NOT EXISTS telephony_connector_accounts (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      provider_key VARCHAR(64) NOT NULL,
      display_name VARCHAR(191) NOT NULL,
      owner_type VARCHAR(32) NOT NULL,
      owner_org_id VARCHAR(191) NULL,
      owner_scope_key VARCHAR(205) GENERATED ALWAYS AS (
        CASE WHEN owner_type = 'platform' THEN 'platform' ELSE CONCAT('organization:',owner_org_id) END
      ) STORED,
      provider_account_id VARCHAR(191) NULL,
      credential_ciphertext MEDIUMTEXT NOT NULL,
      credential_schema_version INT UNSIGNED NOT NULL DEFAULT 1,
      credential_version INT UNSIGNED NOT NULL DEFAULT 1,
      public_config_json JSON NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      last_validated_at DATETIME(6) NULL,
      last_validation_status VARCHAR(32) NULL,
      last_validation_error VARCHAR(1000) NULL,
      created_by VARCHAR(191) NULL,
      updated_by VARCHAR(191) NULL,
      created_at DATETIME(6) NOT NULL,
      updated_at DATETIME(6) NOT NULL,
      UNIQUE KEY uq_telephony_connector_scoped_provider_account (provider_key,owner_scope_key,provider_account_id),
      UNIQUE KEY uq_telephony_connector_provider_id (provider_key,id),
      KEY idx_telephony_connector_owner_status (owner_type,owner_org_id,status,provider_key),
      CONSTRAINT fk_telephony_connector_owner_org FOREIGN KEY (owner_org_id) REFERENCES organizations(id),
      CONSTRAINT chk_telephony_connector_owner_scope CHECK (
        (owner_type = 'platform' AND owner_org_id IS NULL) OR
        (owner_type = 'organization' AND owner_org_id IS NOT NULL)
      )
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS telephony_phone_numbers (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      connector_account_id VARCHAR(191) NOT NULL,
      provider_key VARCHAR(64) NOT NULL,
      provider_number_id VARCHAR(191) NULL,
      phone_number_e164 VARCHAR(32) NOT NULL,
      display_name VARCHAR(191) NULL,
      inventory_status VARCHAR(32) NOT NULL DEFAULT 'available',
      provisioning_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      provider_metadata_json JSON NULL,
      created_at DATETIME(6) NOT NULL,
      updated_at DATETIME(6) NOT NULL,
      UNIQUE KEY uq_telephony_phone_number_e164 (phone_number_e164),
      UNIQUE KEY uq_telephony_phone_provider_number (connector_account_id,provider_number_id),
      UNIQUE KEY uq_telephony_phone_id_account (id,connector_account_id),
      KEY idx_telephony_phone_account_status (connector_account_id,inventory_status,provisioning_status),
      KEY idx_telephony_phone_provider_status (provider_key,inventory_status),
      CONSTRAINT fk_telephony_phone_connector_provider FOREIGN KEY (provider_key,connector_account_id) REFERENCES telephony_connector_accounts(provider_key,id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS telephony_number_assignments (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      phone_number_id VARCHAR(191) NOT NULL,
      org_id VARCHAR(191) NOT NULL,
      workspace_id VARCHAR(191) NOT NULL,
      assigned_by VARCHAR(191) NULL,
      assigned_at DATETIME(6) NOT NULL,
      released_by VARCHAR(191) NULL,
      released_at DATETIME(6) NULL,
      release_reason VARCHAR(1000) NULL,
      active_phone_number_id VARCHAR(191) GENERATED ALWAYS AS (CASE WHEN released_at IS NULL THEN phone_number_id ELSE NULL END) STORED,
      UNIQUE KEY uq_telephony_assignment_active_number (active_phone_number_id),
      KEY idx_telephony_assignment_org_workspace (org_id,workspace_id,released_at,assigned_at),
      KEY idx_telephony_assignment_number_history (phone_number_id,assigned_at),
      CONSTRAINT fk_telephony_assignment_phone FOREIGN KEY (phone_number_id) REFERENCES telephony_phone_numbers(id),
      CONSTRAINT fk_telephony_assignment_workspace FOREIGN KEY (org_id,workspace_id) REFERENCES workspaces(org_id,id),
      CONSTRAINT fk_telephony_assignment_org FOREIGN KEY (org_id) REFERENCES organizations(id)
    )` },
    // Safe, nullable attribution columns let call history retain the exact
    // account/number assignment used by a call. Legacy call logs remain valid.
    { sql: 'ALTER TABLE call_logs ADD COLUMN telephony_provider_key VARCHAR(64) NULL', ignore: ['ER_DUP_FIELDNAME'] },
    { sql: 'ALTER TABLE call_logs ADD COLUMN telephony_connector_account_id VARCHAR(191) NULL', ignore: ['ER_DUP_FIELDNAME'] },
    { sql: 'ALTER TABLE call_logs ADD COLUMN telephony_phone_number_id VARCHAR(191) NULL', ignore: ['ER_DUP_FIELDNAME'] },
    { sql: 'ALTER TABLE call_logs ADD COLUMN telephony_assignment_id VARCHAR(191) NULL', ignore: ['ER_DUP_FIELDNAME'] },
    { sql: 'ALTER TABLE call_logs ADD COLUMN telephony_owner_type VARCHAR(32) NULL', ignore: ['ER_DUP_FIELDNAME'] },
    { sql: 'CREATE INDEX idx_call_logs_telephony_connector ON call_logs (org_id,telephony_connector_account_id,created_at)', ignore: ['ER_DUP_KEYNAME'] },
    { sql: `CREATE TABLE IF NOT EXISTS telephony_call_routes (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      org_id VARCHAR(191) NOT NULL,
      workspace_id VARCHAR(191) NOT NULL,
      provider_key VARCHAR(64) NOT NULL,
      connector_account_id VARCHAR(191) NOT NULL,
      phone_number_id VARCHAR(191) NOT NULL,
      assignment_id VARCHAR(191) NOT NULL,
      owner_type VARCHAR(32) NOT NULL,
      direction VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'starting',
      credential_version INT UNSIGNED NOT NULL DEFAULT 1,
      callback_secret_hash CHAR(64) NOT NULL,
      started_at DATETIME(6) NOT NULL,
      ended_at DATETIME(6) NULL,
      failure_code VARCHAR(64) NULL,
      KEY idx_telephony_route_org_workspace_status (org_id,workspace_id,status,started_at),
      KEY idx_telephony_route_account_status (connector_account_id,status,started_at)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS telephony_call_route_aliases (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      route_id VARCHAR(191) NOT NULL,
      provider_key VARCHAR(64) NOT NULL,
      provider_call_id VARCHAR(191) NOT NULL,
      created_at DATETIME(6) NOT NULL,
      UNIQUE KEY uq_telephony_route_provider_call (provider_key,provider_call_id),
      KEY idx_telephony_route_alias_route (route_id),
      CONSTRAINT fk_telephony_route_alias_route FOREIGN KEY (route_id)
        REFERENCES telephony_call_routes(id) ON DELETE CASCADE
    )` },
  ],
};
