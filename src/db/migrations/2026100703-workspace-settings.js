// Additive expansion: legacy default settings remain available as a fallback.
module.exports = {
  id: '2026100703_workspace_settings',
  steps: [{ sql: 'ALTER TABLE workspaces ADD COLUMN settings JSON NULL', ignore: ['ER_DUP_FIELDNAME'] }],
};
