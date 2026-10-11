module.exports = {
  id: '2026100726_workspace_member_management',
  steps: [
    { sql: `ALTER TABLE org_members ADD COLUMN created_by_user_id VARCHAR(191) NULL`, ignore: ['ER_DUP_FIELDNAME'] },
  ],
};
