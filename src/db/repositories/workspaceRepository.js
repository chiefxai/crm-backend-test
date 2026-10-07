// Child workspace persistence. No second workspace provisioning is exposed
// until all operational repositories and background jobs enforce its scope.
const db = require('../client');
const { pool } = require('../pool');
function parseSettings(value) {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { value = {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function toApi(row, { includeSettings = false } = {}) {
  return row ? { id: row.id, orgId: row.org_id, name: row.name, industry: row.industry,
    branchName: row.branch_name, status: row.status, isDefault: Boolean(row.is_default), ...(includeSettings ? { settings: parseSettings(row.settings) } : {}) } : null;
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
async function getActive(orgId, workspaceId) {
  await db.ready;
  const { rows } = await pool.query(`SELECT w.* FROM workspaces w
    INNER JOIN organizations o ON o.id=w.org_id
    WHERE w.org_id=? AND w.id=? AND w.status='Active'
    AND (o.status IS NULL OR o.status <> 'Suspended')`, [orgId, workspaceId]);
  return toApi(rows[0], { includeSettings: true });
}
async function listForOrg(orgId) {
  await db.ready;
  await ensureDefault(orgId);
  const { rows } = await pool.query('SELECT * FROM workspaces WHERE org_id=? ORDER BY is_default DESC,id', [orgId]);
  return rows.map(row => toApi(row));
}
async function updateSettings(orgId, workspaceId, patch) {
  await db.ready;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid workspace settings');
  // JSON_SET applies only supplied keys atomically; parallel voice/profile
  // saves cannot overwrite each other's independent settings.
  const entries = Object.entries(patch);
  if (!entries.length) return getActive(orgId, workspaceId);
  if (entries.some(([key]) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key))) throw new Error('Invalid settings key');
  const parameters = entries.flatMap(([key, value]) => [`$.${key}`, JSON.stringify(value)]);
  await pool.query(`UPDATE workspaces SET name=COALESCE(?,name),industry=COALESCE(?,industry),branch_name=CASE WHEN ? THEN ? ELSE branch_name END,settings=JSON_SET(COALESCE(settings,JSON_OBJECT()),
    ${entries.map(() => '?,CAST(? AS JSON)').join(',')}) WHERE org_id=? AND id=? AND status='Active'`,
    [patch.workspaceName || null,patch.industry || null,Object.hasOwn(patch,'branchName'),patch.branchName ?? null,...parameters,orgId,workspaceId]);
  return getActive(orgId, workspaceId);
}
async function getProfile(orgId, workspaceId) {
  const [org,workspace] = await Promise.all([
    require('./organizationRepository').get(orgId),getActive(orgId,workspaceId),
  ]);
  if (!org || !workspace) throw new Error('Active workspace not found');
  const profile = workspace.isDefault ? { ...org } : {
    id: org.id, name: org.name, subscriptionPlan: org.subscriptionPlan,
    billingMethod: org.billingMethod, rechargeBalanceInr: org.rechargeBalanceInr,
    rechargeReservedInr: org.rechargeReservedInr, aiMinutesUsed: org.aiMinutesUsed,
    phoneCharges: org.phoneCharges, billingPeriodEnd: org.billingPeriodEnd,
  };
  return { ...profile,...workspace.settings,id: org.id,organizationId: org.id,
    workspaceId: workspace.id,workspaceName: workspace.name,industry: workspace.industry };
}
module.exports = { getDefault, ensureDefault, ensureDefaultMembership, getActive, listForOrg, updateSettings, getProfile };
