// Child workspace persistence. No second workspace provisioning is exposed
// until all operational repositories and background jobs enforce its scope.
const db = require('../client');
const { pool } = require('../pool');
function toApi(row) {
  return row ? { id: row.id, orgId: row.org_id, name: row.name, industry: row.industry,
    branchName: row.branch_name, status: row.status, isDefault: Boolean(row.is_default) } : null;
}
async function ensureDefault(orgId, client = pool) {
  await client.query(`INSERT INTO workspaces (id,org_id,name,industry,status,is_default,created_at)
    SELECT id,id,COALESCE(NULLIF(workspace_name,''),name,'Default workspace'),COALESCE(NULLIF(industry,''),'lending'),
    CASE WHEN status='Suspended' THEN 'Suspended' ELSE 'Active' END,1,COALESCE(created_at,?)
    FROM organizations WHERE id=? ON DUPLICATE KEY UPDATE id=workspaces.id`, [new Date().toISOString(), orgId]);
}
async function getDefault(orgId) {
  await db.ready;
  const { rows } = await pool.query('SELECT * FROM workspaces WHERE org_id=? AND id=? AND is_default=1', [orgId,orgId]);
  if (rows[0]) return toApi(rows[0]);
  // Compatibility for legacy seed/import paths that insert organizations.
  await ensureDefault(orgId);
  const result = await pool.query('SELECT * FROM workspaces WHERE org_id=? AND id=? AND is_default=1', [orgId,orgId]);
  return toApi(result.rows[0]);
}
async function ensureDefaultMembership(orgId, memberId, client = pool) {
  await client.query(`INSERT INTO workspace_members (workspace_id,org_id,member_id,role,status,created_at)
    SELECT m.org_id,m.org_id,m.id,
    CASE WHEN m.role IN ('Organization Admin','Super Admin') THEN 'Workspace Admin'
      WHEN m.role='Manager' THEN 'Manager' WHEN m.role='Viewer' THEN 'Viewer' ELSE 'Member' END,
    COALESCE(NULLIF(m.status,''),'Active'),COALESCE(m.created_at,?)
    FROM org_members m INNER JOIN workspaces w ON w.org_id=m.org_id AND w.id=m.org_id
    WHERE m.org_id=? AND m.id=? ON DUPLICATE KEY UPDATE member_id=workspace_members.member_id`,
    [new Date().toISOString(),orgId,memberId]);
}
module.exports = { getDefault, ensureDefault, ensureDefaultMembership };
