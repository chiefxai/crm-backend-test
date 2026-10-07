// Move organization-wide configuration keys to the workspace boundary before
// allowing independently configured workspaces. Keep provider external IDs
// globally unique so inbound routing can still resolve exactly one owner.
module.exports = {
  id: '2026100705_workspace_configuration_keys',
  steps: [
    { sql: 'ALTER TABLE questionnaires DROP PRIMARY KEY', ignore: ['ER_CANT_DROP_FIELD_OR_KEY'] },
    { sql: 'ALTER TABLE questionnaires ADD PRIMARY KEY (org_id,workspace_id)', ignore: ['ER_MULTIPLE_PRI_KEY'] },
    { sql: 'ALTER TABLE channels DROP INDEX idx_channels_org_type', ignore: ['ER_CANT_DROP_FIELD_OR_KEY'] },
    { sql: 'CREATE UNIQUE INDEX idx_channels_org_workspace_type ON channels (org_id,workspace_id,type)', ignore: ['ER_DUP_KEYNAME'] },
  ],
};
