// Workspace persistence and provisioning boundary.
const db = require('../client');
const { pool } = require('../pool');
const crypto = require('crypto');
const industryPacks = require('../../seed/industryPacks');
const organizationPolicy = require('../../workspaces/organizationPolicy');
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
    CASE WHEN m.role IN ('Owner','Organization Admin','Super Admin','Workspace Admin') THEN 'Workspace Admin'
      WHEN m.role IN ('Manager','Sales Manager') THEN 'Manager' WHEN m.role IN ('Viewer','Customer') THEN 'Viewer' ELSE 'Member' END,
    CASE WHEN m.role='Billing Admin' THEN 'Inactive' ELSE COALESCE(NULLIF(m.status,''),'Active') END,COALESCE(m.created_at,?)
    FROM org_members m INNER JOIN workspaces w ON w.org_id=m.org_id AND w.id=m.org_id
    WHERE m.org_id=? AND m.id=? AND m.workspace_assignments_initialized=0 ON DUPLICATE KEY UPDATE member_id=workspace_members.member_id`,
    [new Date().toISOString(),orgId,memberId]);
  await client.query(`UPDATE org_members m SET workspace_assignments_initialized=1
    WHERE m.org_id=? AND m.id=? AND EXISTS (SELECT 1 FROM workspace_members wm
      WHERE wm.org_id=m.org_id AND wm.member_id=m.id)`,[orgId,memberId]);
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
async function listForMember(orgId, memberId) {
  await db.ready;
  const { rows } = await pool.query(`SELECT w.*,wm.role AS workspace_role FROM workspaces w
    INNER JOIN workspace_members wm ON wm.org_id=w.org_id AND wm.workspace_id=w.id AND wm.member_id=?
    INNER JOIN org_members m ON m.org_id=wm.org_id AND m.id=wm.member_id
    WHERE w.org_id=? AND w.status='Active' AND wm.status='Active'
      AND COALESCE(NULLIF(m.status,''),'Active')='Active'
    ORDER BY w.is_default DESC,w.name,w.id`,[memberId,orgId]);
  return rows.map(row => ({ ...toApi(row), role: row.workspace_role }));
}
async function seedIndustryObjects(client,orgId,workspaceId,industry,createdAt) {
  const pack = industryPacks.getPack(industry) || [];
  for (let objectPosition=0; objectPosition<pack.length; objectPosition++) {
    const spec = pack[objectPosition];
    const objectId = crypto.randomUUID();
    await client.query(`INSERT INTO objects (id,org_id,workspace_id,\`key\`,label,icon,description,has_pipeline,position,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,[objectId,orgId,workspaceId,spec.key,spec.label,spec.icon || 'Layers',spec.description || null,spec.hasPipeline !== false,objectPosition,createdAt]);
    for (let position=0;position<(spec.fields || []).length;position++) {
      const field = spec.fields[position];
      await client.query(`INSERT INTO object_fields (id,org_id,workspace_id,object_id,\`key\`,label,type,options,required,position,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[crypto.randomUUID(),orgId,workspaceId,objectId,field.key,field.label,field.type || 'text',JSON.stringify(field.options || []),!!field.required,position,createdAt]);
    }
    for (let position=0;position<(spec.stages || []).length;position++) {
      const stage = spec.stages[position];
      await client.query(`INSERT INTO object_stages (id,org_id,workspace_id,object_id,\`key\`,label,color,position,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,[crypto.randomUUID(),orgId,workspaceId,objectId,stage.key,stage.label,stage.color || '#6366f1',position,createdAt]);
    }
  }
}
async function createWorkspace(orgId, { name, industry, branchName = null, pricingAcceptanceToken }, initialAdminMemberId, { platformAdmin = false } = {}) {
  await db.ready;
  const client = await pool.connect();
  const workspaceId = crypto.randomUUID();
  const now = new Date().toISOString();
  const maxWorkspaces = Math.max(2, Math.min(Number(process.env.MAX_WORKSPACES_PER_ORG) || 100, 1000));
  try {
    await client.query('BEGIN');
    const { rows: organizations } = await client.query(
      'SELECT id,status,industry,settings FROM organizations WHERE id=? FOR UPDATE',[orgId]);
    if (!organizations[0] || String(organizations[0].status || 'Active').toLowerCase() === 'suspended') {
      throw Object.assign(new Error('An active organization is required'),{ statusCode:404 });
    }
    const { rows: existingWorkspaces } = await client.query('SELECT id,industry FROM workspaces WHERE org_id=? ORDER BY id',[orgId]);
    const policy = organizationPolicy.effectivePolicy(organizations[0],existingWorkspaces);
    if (!industryPacks.listIndustries().some(item => item.key === industry)) throw organizationPolicy.invalid('Select a supported workspace industry.');
    if (!name || name.length > 120 || (branchName && branchName.length > 160)) throw organizationPolicy.invalid('Enter a valid workspace and branch name.');
    const authorizedPolicy=organizationPolicy.authorizeCreation(policy,existingWorkspaces,{industry,platformAdmin,pricingAcceptanceToken});
    if (policy.mode === 'single') {
      policy.mode = authorizedPolicy.mode;
      await client.query("UPDATE organizations SET settings=JSON_SET(COALESCE(settings,JSON_OBJECT()),'$.workspacePolicy',CAST(? AS JSON)) WHERE id=?",[JSON.stringify(policy),orgId]);
    }
    if (existingWorkspaces.length >= maxWorkspaces) {
      throw Object.assign(new Error(`Workspace limit reached (${maxWorkspaces})`),{ statusCode:409 });
    }
    const { rows: duplicateRows } = await client.query(
      'SELECT id FROM workspaces WHERE org_id=? AND LOWER(name)=LOWER(?) LIMIT 1',[orgId,name]);
    if (duplicateRows[0]) throw Object.assign(new Error('A workspace with this name already exists'),{ statusCode:409 });
    const { rows: members } = await client.query(
      `SELECT id FROM org_members WHERE org_id=? AND id=?
       AND COALESCE(NULLIF(status,''),'Active')='Active' FOR UPDATE`,[orgId,initialAdminMemberId]);
    if (!members[0]) throw Object.assign(new Error('An active organization member is required to administer the workspace'),{ statusCode:403 });

    const organizationPricing=organizationPolicy.quote(policy,[...existingWorkspaces,{industry}]);
    const billingAgreement={organizationMonthlyQuoteAtCreation:organizationPricing,acceptedAt:now,createdByPlatformAdmin:platformAdmin};
    await client.query(`INSERT INTO workspaces (id,org_id,name,industry,branch_name,status,is_default,created_at,settings)
      VALUES (?,?,?,?,?,'Active',0,?,?)`,[workspaceId,orgId,name,industry,branchName,now,JSON.stringify({billingAgreement,enabledFeatures:[]})]);
    await client.query(`INSERT INTO workspace_members (workspace_id,org_id,member_id,role,status,role_source,created_at)
      VALUES (?,?,?,'Workspace Admin','Active','manual',?)`,[workspaceId,orgId,initialAdminMemberId,now]);
    await seedIndustryObjects(client,orgId,workspaceId,industry,now);
    await client.query('COMMIT');
    return { id:workspaceId,orgId,name,industry,branchName,status:'Active',isDefault:false,organizationPricing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}
async function updateSettings(orgId, workspaceId, patch) {
  await db.ready;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid workspace settings');
  if (patch.industry !== undefined) {
    const current = await getActive(orgId,workspaceId);
    if (!current) throw organizationPolicy.invalid('Workspace not found',404);
    organizationPolicy.validateIndustryChange(current.industry,patch.industry);
  }
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
async function getAssignment(orgId,workspaceId,memberId) {
  await db.ready;
  const { rows } = await pool.query(`SELECT wm.role,wm.status,wm.role_source FROM workspace_members wm
    INNER JOIN org_members m ON m.org_id=wm.org_id AND m.id=wm.member_id
    WHERE wm.org_id=? AND wm.workspace_id=? AND wm.member_id=?
    AND COALESCE(NULLIF(m.status,''),'Active')='Active'`,[orgId,workspaceId,memberId]);
  return rows[0] || null;
}
async function listMembers(orgId,workspaceId) {
  await db.ready;
  const { rows } = await pool.query(`SELECT m.id AS member_id,m.name,m.email,m.role AS organization_role,
    m.status AS member_status,wm.role AS workspace_role,wm.status AS assignment_status,
    wm.role_source,wm.created_at AS assigned_at
    FROM org_members m LEFT JOIN workspace_members wm
      ON wm.org_id=m.org_id AND wm.workspace_id=? AND wm.member_id=m.id
    WHERE m.org_id=? ORDER BY m.name,m.email,m.id`,[workspaceId,orgId]);
  return rows.map(row => ({ memberId: row.member_id,name: row.name,email: row.email,
    organizationRole: row.organization_role,memberStatus: row.member_status || 'Active',
    workspaceRole: row.workspace_role || null,assignmentStatus: row.assignment_status || null,
    roleSource: row.role_source || null,assignedAt: row.assigned_at || null }));
}
async function setMemberAssignment(orgId,workspaceId,memberId,role,status='Active') {
  await db.ready;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: workspaces } = await client.query(
      'SELECT id FROM workspaces WHERE org_id=? AND id=? FOR UPDATE',[orgId,workspaceId]);
    if (!workspaces[0]) throw Object.assign(new Error('Workspace not found'),{ statusCode:404 });
    const { rows: members } = await client.query(
      'SELECT id,role,status FROM org_members WHERE org_id=? AND id=? FOR UPDATE',[orgId,memberId]);
    if (!members[0] || String(members[0].status || 'Active').toLowerCase() !== 'active') {
      throw Object.assign(new Error('An active organization member is required'),{ statusCode:404 });
    }
    const { rows: currentRows } = await client.query(
      'SELECT role,status,role_source FROM workspace_members WHERE org_id=? AND workspace_id=? AND member_id=? FOR UPDATE',
      [orgId,workspaceId,memberId]);
    const current = currentRows[0] || null;
    const remainsAdmin = status === 'Active' && role === 'Workspace Admin';
    const wasAdmin = current?.status === 'Active' && (current.role_source === 'legacy'
      ? ['Owner','Organization Admin','Super Admin','Workspace Admin'].includes(members[0].role)
      : current.role === 'Workspace Admin');
    if (wasAdmin && !remainsAdmin) {
      const { rows: countRows } = await client.query(`SELECT COUNT(*) AS admin_count FROM workspace_members wm
        INNER JOIN org_members m ON m.org_id=wm.org_id AND m.id=wm.member_id
        WHERE wm.org_id=? AND wm.workspace_id=? AND wm.member_id<>? AND wm.status='Active'
        AND COALESCE(NULLIF(m.status,''),'Active')='Active'
        AND ((wm.role_source='legacy' AND m.role IN ('Owner','Organization Admin','Super Admin','Workspace Admin'))
          OR (wm.role_source<>'legacy' AND wm.role='Workspace Admin'))`,[orgId,workspaceId,memberId]);
      if (Number(countRows[0]?.admin_count || 0) < 1) {
        throw Object.assign(new Error('Assign another active Workspace Admin before removing the last one'),{ statusCode:409 });
      }
    }
    if (current) {
      await client.query(`UPDATE workspace_members SET role=?,status=?,role_source='manual'
        WHERE org_id=? AND workspace_id=? AND member_id=?`,[role,status,orgId,workspaceId,memberId]);
    } else if (status === 'Active') {
      await client.query(`INSERT INTO workspace_members (workspace_id,org_id,member_id,role,status,role_source,created_at)
        VALUES (?,?,?,?,?,'manual',?)`,[workspaceId,orgId,memberId,role,status,new Date().toISOString()]);
    } else {
      throw Object.assign(new Error('Member has no workspace assignment'),{ statusCode:404 });
    }
    await client.query('COMMIT');
    return { memberId,role,status,roleSource:'manual' };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}
async function getAuthorizationState(orgId,workspaceId,memberId) {
  await db.ready;
  const { rows } = await pool.query(`SELECT w.status AS workspace_status,o.status AS organization_status,
    wm.role,wm.status,wm.role_source FROM workspaces w
    INNER JOIN organizations o ON o.id=w.org_id
    LEFT JOIN workspace_members wm ON wm.org_id=w.org_id AND wm.workspace_id=w.id AND wm.member_id=?
    WHERE w.org_id=? AND w.id=?`,[memberId || null,orgId,workspaceId]);
  return rows[0] || null;
}
async function getWorkspaceSetup(orgId) {
  await db.ready;
  const org = await require('./organizationRepository').get(orgId);
  if (!org) throw organizationPolicy.invalid('Organization not found',404);
  const workspaces = await listForOrg(orgId);
  const policy = organizationPolicy.effectivePolicy(org,workspaces);
  return { policy, workspaces, currentQuote: organizationPolicy.quote(policy,workspaces), addBranchQuote: organizationPolicy.branchQuote(policy,workspaces) };
}
async function setWorkspacePolicy(orgId,input) {
  await db.ready;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows:orgs} = await client.query('SELECT industry FROM organizations WHERE id=? FOR UPDATE',[orgId]);
    if (!orgs[0]) throw organizationPolicy.invalid('Organization not found',404);
    const policy = organizationPolicy.validatePolicy(input,orgs[0].industry || 'lending',industryPacks.listIndustries().map(i=>i.key));
    const {rows:workspaces} = await client.query('SELECT id,industry FROM workspaces WHERE org_id=?',[orgId]);
    if (policy.mode==='single' && workspaces.length>1) throw organizationPolicy.invalid('An organization with multiple workspaces cannot use single-workspace mode.');
    if (policy.mode!=='mixed_industry' && workspaces.some(w=>w.industry!==policy.primaryIndustry)) throw organizationPolicy.invalid('Existing workspaces use different industries; select mixed industries.');
    await client.query("UPDATE organizations SET settings=JSON_SET(COALESCE(settings,JSON_OBJECT()),'$.workspacePolicy',CAST(? AS JSON)) WHERE id=?",[JSON.stringify(policy),orgId]);
    await client.query('COMMIT');
  } catch(error) { try {await client.query('ROLLBACK');} catch {} throw error; }
  finally {client.release();}
  return getWorkspaceSetup(orgId);
}
module.exports = { getWorkspaceSetup, setWorkspacePolicy, seedIndustryObjects, getDefault, ensureDefault, ensureDefaultMembership, getActive, listForOrg, listForMember, createWorkspace, updateSettings, getProfile, getAssignment, listMembers, setMemberAssignment, getAuthorizationState };
