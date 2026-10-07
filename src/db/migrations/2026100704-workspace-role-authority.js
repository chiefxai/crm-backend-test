module.exports = {
  id: '2026100704_workspace_role_authority',
  steps: [
    { sql: "ALTER TABLE workspace_members ADD COLUMN role_source VARCHAR(20) NOT NULL DEFAULT 'legacy'", ignore: ['ER_DUP_FIELDNAME'] },
    { sql: "ALTER TABLE org_members ADD COLUMN workspace_assignments_initialized TINYINT NOT NULL DEFAULT 0", ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `UPDATE org_members m SET workspace_assignments_initialized=1 WHERE EXISTS (
      SELECT 1 FROM workspace_members wm WHERE wm.org_id=m.org_id AND wm.member_id=m.id)` },
    // Initial assignments were generated from organization roles. They remain
    // derived until explicitly managed; legacy team role demotions take effect
    // immediately rather than leaving a stale workspace grant behind.
    { sql: `UPDATE workspace_members wm INNER JOIN org_members m ON m.org_id=wm.org_id AND m.id=wm.member_id
      SET wm.status='Inactive' WHERE wm.workspace_id=wm.org_id AND wm.role_source='legacy' AND m.role='Billing Admin'` },
  ],
};
