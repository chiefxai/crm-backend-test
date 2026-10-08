// Organization-specific persistence boundary.
// Keep organization/GCP metadata access out of the large legacy repository.
const supabase = require("../client");
const crypto = require("crypto");
const { encryptJson } = require("../../security/channelCredentials");

const { pool } = require("../pool");

const CORE_FIELDS = {
  name: "name", workspaceName: "workspace_name", industry: "industry",
  subscriptionPlan: "subscription_plan", aiMinutesUsed: "ai_minutes_used",
  aiMinutesLimit: "ai_minutes_limit", phoneCharges: "phone_charges",
  billingPeriodEnd: "billing_period_end", status: "status",
  featureFlags: "feature_flags", createdAt: "created_at",
  billingMethod: "billing_method", chargeScope: "charge_scope",
  rechargeBalanceInr: "recharge_balance_inr", rechargeReservedInr: "recharge_reserved_inr"
};

function toApi(row) {
  if (!row) return row;
  const api = { id: row.id, ...(row.settings || {}) };
  for (const [apiKey, dbKey] of Object.entries(CORE_FIELDS)) {
    if (row[dbKey] !== undefined && row[dbKey] !== null) api[apiKey] = row[dbKey];
  }
  return api;
}

function split(apiObj) {
  const row = {};
  const settings = {};
  for (const [key, value] of Object.entries(apiObj || {})) {
    if (key === "id") continue;
    if (CORE_FIELDS[key]) row[CORE_FIELDS[key]] = value;
    else settings[key] = value;
  }
  return { row, settings };
}

async function createOrganizationSetup({
  name, workspaceName, industry, subscriptionPlan, featureFlags, adminEmail, adminName, gcpProject, callProvider,
  billingMethod = "pay_as_you_go", chargeScope = "ai_only", initialRechargeAmountInr = 0,
  dataRetentionMode = "default", dataRetentionOverrides = {}, backup = null,
  workspacePolicy, initialWorkspaces = [], firstBranchName = null,
}) {
  await supabase.ready;
  const client = await pool.connect(); const orgId = crypto.randomUUID();
  const cloudProjectId = `orgcloud_${orgId}_vertex_ai`; const memberId = adminEmail ? crypto.randomUUID() : null; const now = new Date().toISOString();
  try {
    await client.query("BEGIN");
    const normalizedBillingMethod = billingMethod === "recharge_based" ? "recharge_based" : "pay_as_you_go";
    const normalizedChargeScope = chargeScope === "ai_and_call_provider" ? "ai_and_call_provider" : "ai_only";
    const initialBalance = normalizedBillingMethod === "recharge_based" ? Math.max(0, Number(initialRechargeAmountInr) || 0) : 0;
    const orgSettings = {
      ...(workspacePolicy ? { workspacePolicy } : {}),
      dataRetention: {
        mode: dataRetentionMode === "custom" ? "custom" : "default",
        overrides: dataRetentionMode === "custom" && dataRetentionOverrides && typeof dataRetentionOverrides === "object" ? dataRetentionOverrides : {},
        updatedAt: now,
      },
      ...(backup && typeof backup === "object" ? { dataBackup: backup } : {}),
    };
    await client.query(`INSERT INTO organizations (id,name,workspace_name,industry,subscription_plan,feature_flags,billing_method,charge_scope,recharge_balance_inr,recharge_reserved_inr,settings,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [orgId,name,workspaceName,industry||"lending",subscriptionPlan||"Starter",JSON.stringify(featureFlags||[]),normalizedBillingMethod,normalizedChargeScope,initialBalance,0,JSON.stringify(orgSettings),now]);
    await require("./workspaceRepository").ensureDefault(orgId, client);
    await client.query(`INSERT INTO organization_cloud_projects (id,organization_id,organization_name,provider,purpose,mode,project_id,project_number,location,credentials_encrypted,status,updated_at) VALUES ($1,$2,$3,'gcp','vertex-ai','existing',$4,$5,$6,$7,'ready',$8)`, [cloudProjectId,orgId,name,gcpProject.projectId,gcpProject.projectNumber||null,gcpProject.location||null,gcpProject.credentialsEncrypted||null,now]);
    if (callProvider) {
      // The route checks number availability, but a concurrent setup can
      // claim it before this transaction inserts. Let the unique constraint
      // reject that race; updating on duplicate would replace another
      // organization's provider credentials.
      await client.query(`INSERT INTO channels (id,org_id,workspace_id,type,external_id,config,credentials_encrypted,status,created_at) VALUES ($1,$2,$2,$3,$4,$5,$6,'connected',$7)`, [crypto.randomUUID(),orgId,callProvider.provider,callProvider.phoneNumber,JSON.stringify({phoneNumber:callProvider.phoneNumber}),encryptJson({authId:callProvider.authId,authToken:callProvider.authToken}),now]);
      // Connecting the call-provider channel above only makes the number
      // usable for placing calls — it does not show up in the org's own
      // Virtual Numbers list (a separate `virtual_numbers` table) until
      // someone re-submits the "Add Virtual Number" form. Insert that row
      // here too so the number the super admin just assigned is visible
      // immediately, matching what that form itself would create.
      const providerLabel = callProvider.provider === "vobiz" ? "Vobiz.ai" : callProvider.provider;
      await client.query(`INSERT INTO virtual_numbers (id,org_id,workspace_id,number,provider,status,friendly_name,routing_url,incoming_call_count,outgoing_call_count,created_at) VALUES ($1,$2,$2,$3,$4,'Active',$5,$6,0,0,$7)`, [crypto.randomUUID(),orgId,callProvider.phoneNumber,providerLabel,`${providerLabel} Line`,"https://api.chiefxai.com/voice/webhook-dynamic",now]);
    }
    if (adminEmail) await client.query(`INSERT INTO org_members (id,org_id,user_id,email,name,role,feature_flags,created_at) VALUES ($1,$2,NULL,$3,$4,'Organization Admin',$5,$6)`, [memberId,orgId,adminEmail.toLowerCase(),adminName||adminEmail,JSON.stringify(featureFlags||[]),now]);
    if (memberId) await client.query(`INSERT INTO workspace_members (workspace_id,org_id,member_id,role,status,created_at) VALUES (?,?,?,'Workspace Admin','Active',?)`, [orgId,orgId,memberId,now]);
    if (memberId) await client.query('UPDATE org_members SET workspace_assignments_initialized=1 WHERE org_id=? AND id=?',[orgId,memberId]);
    const workspaceRepository = require('./workspaceRepository');
    if (firstBranchName) await client.query('UPDATE workspaces SET name=?,branch_name=? WHERE org_id=? AND id=?',[firstBranchName,firstBranchName,orgId,orgId]);
    for (const branch of initialWorkspaces) {
      const workspaceId = crypto.randomUUID();
      await client.query(`INSERT INTO workspaces (id,org_id,name,industry,branch_name,status,is_default,created_at)
        VALUES (?,?,?,?,?,'Active',0,?)`,[workspaceId,orgId,branch.name,branch.industry,branch.branchName || null,now]);
      await client.query(`INSERT INTO workspace_members (workspace_id,org_id,member_id,role,status,role_source,created_at)
        VALUES (?,?,?,'Workspace Admin','Active','manual',?)`,[workspaceId,orgId,memberId,now]);
      await workspaceRepository.seedIndustryObjects(client,orgId,workspaceId,branch.industry,now);
    }

    await client.query("COMMIT");
    const orgResult=await client.query(`SELECT * FROM organizations WHERE id = $1`,[orgId]); const cloudResult=await client.query(`SELECT * FROM organization_cloud_projects WHERE id = $1`,[cloudProjectId]);
    return {org:toApi(orgResult.rows[0]),cloudProject:toApiCloudProject(cloudResult.rows[0]),memberId};
  } catch(err){ try{await client.query("ROLLBACK");}catch(_){} throw err; } finally{client.release();}
}

async function create({ name, workspaceName, industry, subscriptionPlan, featureFlags, billingMethod, chargeScope, initialRechargeAmountInr }) {
  const { data, error } = await supabase.from("organizations").insert({
    name,
    workspace_name: workspaceName,
    industry: industry || "lending",
    subscription_plan: subscriptionPlan || "Starter",
    feature_flags: featureFlags || [],
    billing_method: billingMethod === "recharge_based" ? "recharge_based" : "pay_as_you_go",
    charge_scope: chargeScope === "ai_and_call_provider" ? "ai_and_call_provider" : "ai_only",
    recharge_balance_inr: billingMethod === "recharge_based" ? Math.max(0, Number(initialRechargeAmountInr) || 0) : 0,
    recharge_reserved_inr: 0
  }).select().single();
  if (error) throw new Error(`[organizationRepository.create] ${error.message}`);
  return toApi(data);
}

async function get(orgId) {
  const { data, error } = await supabase.from("organizations").select("*").eq("id", orgId).maybeSingle();
  if (error) throw new Error(`[organizationRepository.get] ${error.message}`);
  return toApi(data);
}

async function update(orgId, patch) {
  const existing = await get(orgId);
  if (!existing) throw new Error("Organization not found");
  const { row, settings } = split({ ...existing, ...patch });
  const { data, error } = await supabase.from("organizations").update({ ...row, settings }).eq("id", orgId).select().single();
  if (error) throw new Error(`[organizationRepository.update] ${error.message}`);
  if (patch.status !== undefined) {
    // The initial workspace originally mirrored org suspension. Keep that
    // mirror reversible when the platform reactivates a legacy organization.
    await pool.query("UPDATE workspaces SET status=? WHERE org_id=? AND id=? AND is_default=1",
      [patch.status === 'Suspended' ? 'Suspended' : 'Active',orgId,orgId]);
  }
  return toApi(data);
}

async function createCloudProjectRecord({ orgId, organizationName, status = "pending", mode = "automatic", projectId, projectNumber, location, credentialsEncrypted }) {
  const id = `orgcloud_${orgId}_vertex_ai`;
  const { data, error } = await supabase.from("organization_cloud_projects").upsert({
    id,
    organization_id: orgId,
    organization_name: organizationName,
    provider: "gcp",
    purpose: "vertex-ai",
    mode,
    project_id: projectId || null,
    project_number: projectNumber || null,
    location: location || null,
    credentials_encrypted: credentialsEncrypted || null,
    status,
    updated_at: new Date().toISOString()
  }).select().single();
  if (error) throw new Error(`[organizationRepository.createCloudProjectRecord] ${error.message}`);
  return toApiCloudProject(data);
}

async function getCloudProject(orgId, provider = "gcp", purpose = "vertex-ai") {
  const { data, error } = await supabase.from("organization_cloud_projects").select("*")
    .eq("organization_id", orgId).eq("provider", provider).eq("purpose", purpose).maybeSingle();
  if (error) throw new Error(`[organizationRepository.getCloudProject] ${error.message}`);
  return toApiCloudProject(data || null);
}

async function getCloudProjectWithCredentials(orgId, provider = "gcp", purpose = "vertex-ai") {
  const { data, error } = await supabase.from("organization_cloud_projects").select("*")
    .eq("organization_id", orgId).eq("provider", provider).eq("purpose", purpose).maybeSingle();
  if (error) throw new Error(`[organizationRepository.getCloudProjectWithCredentials] ${error.message}`);
  return data || null;
}

function toApiCloudProject(row) {
  if (!row) return null;
  const { credentials_encrypted, ...safe } = row;
  return safe;
}

async function updateCloudProject(orgId, patch, provider = "gcp", purpose = "vertex-ai") {
  const existing = await getCloudProject(orgId, provider, purpose);
  if (!existing) await createCloudProjectRecord({ orgId, organizationName: patch.organizationName || "Organization", status: patch.status || "pending" });
  const values = { ...patch, updated_at: new Date().toISOString() };
  if (values.organizationName !== undefined) { values.organization_name = values.organizationName; delete values.organizationName; }
  if (values.projectId !== undefined) { values.project_id = values.projectId; delete values.projectId; }
  if (values.projectNumber !== undefined) { values.project_number = values.projectNumber; delete values.projectNumber; }
  if (values.billingAccount !== undefined) { values.billing_account = values.billingAccount; delete values.billingAccount; }
  if (values.provisionedAt !== undefined) { values.provisioned_at = values.provisionedAt; delete values.provisionedAt; }
  if (values.credentialsEncrypted !== undefined) { values.credentials_encrypted = values.credentialsEncrypted; delete values.credentialsEncrypted; }
  const { data, error } = await supabase.from("organization_cloud_projects").update(values)
    .eq("organization_id", orgId).eq("provider", provider).eq("purpose", purpose).select().single();
  if (error) throw new Error(`[organizationRepository.updateCloudProject] ${error.message}`);
  return toApiCloudProject(data);
}

async function listCloudProjectsByStatus(statuses = ["pending", "provisioning", "failed"]) {
  const { data, error } = await supabase.from("organization_cloud_projects").select("*");
  if (error) throw new Error(`[organizationRepository.listCloudProjectsByStatus] ${error.message}`);
  const wanted = new Set(statuses);
  return (data || []).filter(row => wanted.has(row.status)).map(toApiCloudProject);
}

async function markCloudProjectRetained(orgId, organizationName) {
  const existing = await getCloudProject(orgId);
  if (!existing) return null;
  const { data, error } = await supabase.from("organization_cloud_projects").update({
    status: "retained",
    organization_name: organizationName || existing.organization_name,
    retained_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("id", existing.id).select().single();
  if (error) throw new Error(`[organizationRepository.markCloudProjectRetained] ${error.message}`);
  return data;
}

async function transferOwner(orgId, currentOwnerId, newOwnerId) {
  if (!currentOwnerId || !newOwnerId || currentOwnerId === newOwnerId) {
    throw Object.assign(new Error("Choose a different active organization member"),{ statusCode:400 });
  }
  await supabase.ready;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM organizations WHERE id=? FOR UPDATE",[orgId]);
    const { rows } = await client.query(`SELECT id,email,role,status FROM org_members
      WHERE org_id=? AND id IN (?,?) ORDER BY id FOR UPDATE`,[orgId,currentOwnerId,newOwnerId]);
    const current = rows.find(row => row.id === currentOwnerId);
    const target = rows.find(row => row.id === newOwnerId);
    if (!current || current.role !== "Owner" || String(current.status || "Active").toLowerCase() !== "active") {
      throw Object.assign(new Error("An active organization Owner is required to transfer ownership"),{ statusCode:409 });
    }
    if (!target || String(target.status || "Active").toLowerCase() !== "active") {
      throw Object.assign(new Error("The new Owner must be an active member of this organization"),{ statusCode:404 });
    }
    await client.query("UPDATE org_members SET role='Organization Admin' WHERE org_id=? AND id=?",[orgId,currentOwnerId]);
    await client.query("UPDATE org_members SET role='Owner' WHERE org_id=? AND id=?",[orgId,newOwnerId]);
    await client.query("COMMIT");
    return { from:{ id:current.id,email:current.email,role:"Organization Admin" },to:{ id:target.id,email:target.email,role:"Owner" } };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally { client.release(); }
}

async function updateSystemAgentPrompt(orgId, agentId, prompt) {
  const client = await pool.connect();
  try {
    const current = await client.query(`SELECT settings FROM organizations WHERE id = $1`, [orgId]);
    if (!current.rows[0]) throw new Error("Organization not found");
    const settings = current.rows[0].settings ? (typeof current.rows[0].settings === "string" ? JSON.parse(current.rows[0].settings) : current.rows[0].settings) : {};
    settings.systemAgentPrompts = settings.systemAgentPrompts || {};
    if (prompt == null) delete settings.systemAgentPrompts[agentId]; else settings.systemAgentPrompts[agentId] = String(prompt);
    await client.query(`UPDATE organizations SET settings = $2 WHERE id = $1`, [orgId, JSON.stringify(settings)]);
    const result = await client.query(`SELECT * FROM organizations WHERE id = $1`, [orgId]);
    return toApi(result.rows[0]);
  } finally { client.release(); }
}

module.exports = { CORE_FIELDS, create, createOrganizationSetup, get, update, toApi, createCloudProjectRecord, getCloudProject, getCloudProjectWithCredentials, toApiCloudProject, updateCloudProject, markCloudProjectRetained, listCloudProjectsByStatus, updateSystemAgentPrompt, transferOwner };
