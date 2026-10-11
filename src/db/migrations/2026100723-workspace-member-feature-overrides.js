// Optional member-specific feature permissions for each workspace.
// NULL preserves legacy organization-member feature grants; [] denies all.
module.exports = {
  id: '2026100723_workspace_member_feature_overrides',
  steps: [
    { sql: "ALTER TABLE workspace_members ADD COLUMN feature_flags_json JSON NULL", ignore: ['ER_DUP_FIELDNAME'] },
  ],
};
