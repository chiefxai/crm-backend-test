module.exports={
  id:'2026100708_workspace_share_proposals',
  steps:[
    {sql:`CREATE TABLE IF NOT EXISTS workspace_share_proposals (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      org_id VARCHAR(191) NOT NULL,
      grant_id VARCHAR(191) NOT NULL,
      source_workspace_id VARCHAR(191) NOT NULL,
      target_workspace_id VARCHAR(191) NOT NULL,
      object_id VARCHAR(191) NOT NULL,
      record_id VARCHAR(191) NOT NULL,
      base_version CHAR(64) NOT NULL,
      proposed_patch JSON NOT NULL,
      previous_data JSON NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      proposed_by_member_id VARCHAR(191) NOT NULL,
      reviewed_by_member_id VARCHAR(191) NULL,
      created_at VARCHAR(40) NOT NULL,
      reviewed_at VARCHAR(40) NULL,
      KEY idx_share_proposals_source (org_id,source_workspace_id,status,created_at,id),
      KEY idx_share_proposals_grant (org_id,grant_id,status),
      CONSTRAINT fk_share_proposal_grant FOREIGN KEY (grant_id) REFERENCES workspace_share_grants(id) ON DELETE CASCADE,
      CONSTRAINT fk_share_proposal_source FOREIGN KEY (org_id,source_workspace_id) REFERENCES workspaces(org_id,id) ON DELETE CASCADE,
      CONSTRAINT fk_share_proposal_target FOREIGN KEY (org_id,target_workspace_id) REFERENCES workspaces(org_id,id) ON DELETE CASCADE,
      CONSTRAINT fk_share_proposal_object FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE
    )`},
  ],
};
