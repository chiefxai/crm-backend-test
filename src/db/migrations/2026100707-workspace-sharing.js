module.exports = {
  id: '2026100707_workspace_sharing',
  steps: [
    { sql: 'CREATE INDEX idx_object_records_share_page ON object_records (org_id(64),workspace_id(64),object_id(64),created_at(40),id(64))', ignore: ['ER_DUP_KEYNAME'] },
    { sql: `CREATE TABLE IF NOT EXISTS workspace_share_grants (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      org_id VARCHAR(191) NOT NULL,
      source_workspace_id VARCHAR(191) NOT NULL,
      target_workspace_id VARCHAR(191) NOT NULL,
      object_id VARCHAR(191) NOT NULL,
      allowed_fields JSON NOT NULL,
      granted_by_member_id VARCHAR(191) NOT NULL,
      expires_at VARCHAR(40) NULL,
      revoked_at VARCHAR(40) NULL,
      created_at VARCHAR(40) NOT NULL,
      KEY idx_workspace_share_target (org_id,target_workspace_id,revoked_at,expires_at),
      KEY idx_workspace_share_source (org_id,source_workspace_id,revoked_at),
      CONSTRAINT fk_workspace_share_source FOREIGN KEY (org_id,source_workspace_id) REFERENCES workspaces(org_id,id) ON DELETE CASCADE,
      CONSTRAINT fk_workspace_share_target FOREIGN KEY (org_id,target_workspace_id) REFERENCES workspaces(org_id,id) ON DELETE CASCADE,
      CONSTRAINT fk_workspace_share_member FOREIGN KEY (org_id,granted_by_member_id) REFERENCES org_members(org_id,id) ON DELETE CASCADE,
      CONSTRAINT fk_workspace_share_object FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE
    )` },
  ],
};
