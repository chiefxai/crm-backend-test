module.exports={
  id:'2026100709_workspace_share_imports',
  steps:[
    {sql:`CREATE TABLE IF NOT EXISTS workspace_share_imports (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      org_id VARCHAR(191) NOT NULL,
      grant_id VARCHAR(191) NOT NULL,
      target_workspace_id VARCHAR(191) NOT NULL,
      source_fingerprint CHAR(64) NOT NULL,
      mapping_fingerprint CHAR(64) NOT NULL,
      target_object_id VARCHAR(191) NOT NULL,
      target_record_id VARCHAR(191) NOT NULL,
      copied_by_member_id VARCHAR(191) NOT NULL,
      created_at VARCHAR(40) NOT NULL,
      UNIQUE KEY uq_workspace_share_import_source (grant_id,source_fingerprint,mapping_fingerprint),
      KEY idx_workspace_share_import_target (org_id,target_workspace_id,created_at),
      KEY idx_workspace_share_import_record (org_id,target_workspace_id,target_object_id,target_record_id),
      CONSTRAINT fk_workspace_share_import_grant FOREIGN KEY (grant_id) REFERENCES workspace_share_grants(id) ON DELETE RESTRICT,
      CONSTRAINT fk_workspace_share_import_workspace FOREIGN KEY (org_id,target_workspace_id) REFERENCES workspaces(org_id,id) ON DELETE CASCADE,
      CONSTRAINT fk_workspace_share_import_object FOREIGN KEY (target_object_id) REFERENCES objects(id) ON DELETE CASCADE
    )`},
  ],
};
