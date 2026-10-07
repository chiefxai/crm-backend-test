// ============================================================
// services/platformAdmin.js
//
// Cross-org queries for the platform-operator panel — deliberately
// bypasses the org_id scoping every other engine in this codebase
// enforces. Only ever called from routes behind requirePlatformAdmin
// (services/auth.js), which is gated by an email allowlist set in
// .env, not by anything an org admin could grant themselves.
// ============================================================

const db = require("../db/repository");
const { costForMinutes, getCostPerMinuteInr, getPhoneCostPerMinute, setPhoneCostPerMinute } = require("./pricing");
const costProviders = require("./costProviders");
const auditLog = require("./auditLog");
const featureFlags = require("./featureFlags");
const dataRetention = require("./dataRetention");
const storage = require("../storage");
const { getLogger } = require("../observability/logger");
const log = getLogger("platform.admin");

async function listOrganizations() {
  const { data: orgs, error } = await db.supabase
    .from("organizations")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`[platformAdmin.listOrganizations] ${error.message}`);

  const [{ data: members }, { data: leads }] = await Promise.all([
    db.supabase.from("org_members").select("org_id"),
    db.supabase.from("leads").select("org_id").systemReadOnly("Aggregate lead counts for the platform organization list")
  ]);

  const memberCounts = {};
  for (const m of members || []) memberCounts[m.org_id] = (memberCounts[m.org_id] || 0) + 1;
  const leadCounts = {};
  for (const l of leads || []) leadCounts[l.org_id] = (leadCounts[l.org_id] || 0) + 1;

  const ratePerMinute = await getCostPerMinuteInr();

  const cloudProjects = await db.supabase.from("organization_cloud_projects").select("organization_id, project_id, status, location");
  const cloudByOrg = {};
  for (const p of cloudProjects.data || []) cloudByOrg[p.organization_id] = p;

  return (orgs || []).map((o) => ({
    id: o.id,
    name: o.name,
    workspaceName: o.workspace_name,
    industry: o.industry,
    subscriptionPlan: o.subscription_plan,
    status: o.status || "Active",
    aiMinutesUsed: o.ai_minutes_used,
    totalCostInr: Math.round((o.ai_minutes_used || 0) * ratePerMinute * 100) / 100,
    billingPeriodEnd: o.billing_period_end,
    memberCount: memberCounts[o.id] || 0,
    leadCount: leadCounts[o.id] || 0,
    createdAt: o.created_at,
    billingMethod: o.billing_method || "pay_as_you_go",
    chargeScope: o.charge_scope || "ai_only",
    rechargeBalanceInr: Number(o.recharge_balance_inr) || 0,
    rechargeReservedInr: Number(o.recharge_reserved_inr) || 0,
    rechargeAvailableInr: Math.max(0, (Number(o.recharge_balance_inr) || 0) - (Number(o.recharge_reserved_inr) || 0)),
    gcpVertexProject: cloudByOrg[o.id] || null
  }));
}

// Users are now managed by Keycloak — we query org_members for membership info.
// Keycloak user details (email, name) are joined from the users table if available,
// falling back to the user_id (Keycloak sub) only.
async function listUsers() {
  const { data: members } = await db.supabase
    .from("org_members")
    .select("user_id, org_id, role, name, email, created_at, organizations(name)");

  return (members || []).map((m) => ({
    id: m.user_id,
    email: m.email || null,
    name: m.name || null,
    createdAt: m.created_at,
    lastSignInAt: null, // available via Keycloak admin API if needed
    orgId: m.org_id,
    orgName: m.organizations?.name || null,
    role: m.role
  }));
}

// Reads from call_logs — the table every voice pipeline (Vobiz)
// actually writes to. The older "calls" table this used to query is
// legacy/unused (always empty), which is why the admin panel's Calls page
// showed nothing despite calls happening every day.
async function listAuditLog(limit = 200) {
  const { data, error } = await db.supabase
    .from("audit_log")
    .select("*, organizations(name)")
    .systemReadOnly("List audit events for platform administrators")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[platformAdmin.listAuditLog] ${error.message}`);
  return (data || []).map((a) => ({
    id: a.id,
    orgId: a.org_id,
    orgName: a.organizations?.name,
    actorEmail: a.actor_email,
    action: a.action,
    targetType: a.target_type,
    targetId: a.target_id,
    metadata: a.metadata,
    createdAt: a.created_at
  }));
}

async function getStats() {
  const [{ count: orgCount }, { count: callCount }, { count: userCount }, orgsRes, aiRowsRes, providers, archive, selfManagedRes] = await Promise.all([
    db.supabase.from("organizations").select("id", { count: "exact", head: true }),
    db.supabase.from("call_logs").select("id", { count: "exact", head: true }).systemReadOnly("Count calls for platform statistics"),
    db.supabase.from("org_members").select("user_id", { count: "exact", head: true }),
    // Platform-wide cost: summed in JS from the same per-org accrued
    // figures each org's own Billing & Usage page shows (organizations.
    // phone_charges is the call cost accrued at finalize time; ai_session_
    // usage.platform_total_cost_inr is each session's AI token cost
    // locked in at ITS finalize time — see billingEngine.js/geminiUsage
    // Tracker.js). Never recomputed against today's rate, same reasoning
    // as the per-org figures: a rate change never retroactively re-prices
    // usage that already happened.
    db.supabase.from("organizations").select("id, phone_charges"),
    db.supabase.from("ai_session_usage").select("platform_total_cost_inr"),
    costProviders.listProviders().catch(() => []),
    db.listCostArchive().catch(() => []),
    // Orgs using their OWN connected Vobiz account (see billingEngine.js's
    // isCallProviderSelfManaged) — the platform never paid for their
    // calls, so their phone_charges is an estimate for their own
    // reference only and must not count toward what the platform is owed.
    db.supabase.from("channels").select("org_id").systemReadOnly("Identify platform customers using self-managed Vobiz").eq("type", "vobiz").eq("status", "connected"),
  ]);

  const selfManagedOrgIds = new Set((selfManagedRes.data || []).map((c) => c.org_id));
  const totalPhoneChargesInr = (orgsRes.data || [])
    .filter((o) => !selfManagedOrgIds.has(o.id))
    .reduce((sum, o) => sum + (Number(o.phone_charges) || 0), 0);
  const totalAiTokenCostInr = (aiRowsRes.data || []).reduce((sum, r) => sum + (Number(r.platform_total_cost_inr) || 0), 0);

  return {
    totalOrganizations: orgCount || 0,
    totalUsers: userCount || 0,
    totalCalls: callCount || 0,
    totalPhoneChargesInr: Math.round(totalPhoneChargesInr * 100) / 100,
    totalAiTokenCostInr: Math.round(totalAiTokenCostInr * 100) / 100,
    selfManagedCallOrgCount: selfManagedOrgIds.size,
    activeCostProviderCount: providers.filter((p) => p.active).length,
    archivedOrgCount: archive.length,
  };
}

function fillDateRange(days) {
  const days_ = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days_.push(d.toISOString().slice(0, 10));
  }
  return days_;
}

function bucketByDay(rows, dateKeys) {
  const counts = {};
  for (const key of dateKeys) counts[key] = 0;
  for (const row of rows) {
    const day = String(row.created_at).slice(0, 10);
    if (day in counts) counts[day]++;
  }
  return dateKeys.map((date) => ({ date, count: counts[date] }));
}

// Daily signups + call volume for the last `days` days, plus plan/industry
// distribution — powers the Overview page's charts. Aggregated in JS after
// a raw fetch rather than a SQL GROUP BY because this compatibility query
// builder intentionally keeps aggregation logic in application code here.
async function getTimeSeries(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const sinceIso = since.toISOString();

  const [{ data: orgs, error: orgErr }, { data: calls, error: callErr }, { data: allOrgs }] = await Promise.all([
    db.supabase.from("organizations").select("created_at").gte("created_at", sinceIso),
    db.supabase.from("call_logs").select("created_at").systemReadOnly("Aggregate call volume for platform statistics").gte("created_at", sinceIso),
    db.supabase.from("organizations").select("subscription_plan, industry")
  ]);
  if (orgErr) throw new Error(`[platformAdmin.getTimeSeries] orgs: ${orgErr.message}`);
  if (callErr) throw new Error(`[platformAdmin.getTimeSeries] calls: ${callErr.message}`);

  const dateKeys = fillDateRange(days);
  const planCounts = {};
  const industryCounts = {};
  for (const o of allOrgs || []) {
    const plan = o.subscription_plan || "Starter";
    const industry = o.industry || "lending";
    planCounts[plan] = (planCounts[plan] || 0) + 1;
    industryCounts[industry] = (industryCounts[industry] || 0) + 1;
  }

  return {
    signupsByDay: bucketByDay(orgs || [], dateKeys),
    callsByDay: bucketByDay(calls || [], dateKeys),
    planDistribution: Object.entries(planCounts).map(([plan, count]) => ({ plan, count })),
    industryDistribution: Object.entries(industryCounts).map(([industry, count]) => ({ industry, count }))
  };
}

// Full drill-down for one org: settings, team, recent calls, recent
// activity, and quick entity counts. Separate from listOrganizations
// (which stays a lightweight summary row) since this does several more
// queries and is only needed when an operator actually opens one org.
async function getOrganizationDetail(orgId) {
  const [
    { data: org, error: orgErr },
    { data: members, error: memErr },
    { data: calls, error: callErr },
    { data: activity, error: actErr },
    { count: leadCount },
    { count: workflowCount },
    { count: campaignCount }
  ] = await Promise.all([
    db.supabase.from("organizations").select("*").eq("id", orgId).maybeSingle(),
    db.supabase.from("org_members").select("*").eq("org_id", orgId).order("created_at", { ascending: false }),
    db.supabase.from("call_logs").select("id, lead_name, duration, sentiment, created_at").systemReadOnly("Show platform-admin organization-wide call history").eq("org_id", orgId).order("created_at", { ascending: false }).limit(10),
    db.supabase.from("audit_log").select("*").systemReadOnly("Show platform-admin organization-wide audit history").eq("org_id", orgId).order("created_at", { ascending: false }).limit(10),
    db.supabase.from("leads").select("id", { count: "exact", head: true }).systemReadOnly("Count all workspaces in platform-admin organization detail").eq("org_id", orgId),
    db.supabase.from("workflows").select("id", { count: "exact", head: true }).systemReadOnly("Count all workspaces in platform-admin organization detail").eq("org_id", orgId),
    db.supabase.from("campaigns").select("id", { count: "exact", head: true }).systemReadOnly("Count all workspaces in platform-admin organization detail").eq("org_id", orgId)
  ]);
  if (orgErr) throw new Error(`[platformAdmin.getOrganizationDetail] ${orgErr.message}`);
  if (!org) {
    const err = new Error("Organization not found");
    err.statusCode = 404;
    throw err;
  }
  if (memErr) throw new Error(`[platformAdmin.getOrganizationDetail] members: ${memErr.message}`);
  if (callErr) throw new Error(`[platformAdmin.getOrganizationDetail] calls: ${callErr.message}`);
  if (actErr) throw new Error(`[platformAdmin.getOrganizationDetail] activity: ${actErr.message}`);

  return {
    id: org.id,
    name: org.name,
    workspaceName: org.workspace_name,
    industry: org.industry,
    subscriptionPlan: org.subscription_plan,
    status: org.status || "Active",
    aiMinutesUsed: org.ai_minutes_used,
    totalCostInr: await costForMinutes(org.ai_minutes_used),
    billingPeriodEnd: org.billing_period_end,
    createdAt: org.created_at,
    billingMethod: org.billing_method || "pay_as_you_go",
    chargeScope: org.charge_scope || "ai_only",
    rechargeBalanceInr: Number(org.recharge_balance_inr) || 0,
    rechargeReservedInr: Number(org.recharge_reserved_inr) || 0,
    rechargeAvailableInr: Math.max(0, (Number(org.recharge_balance_inr) || 0) - (Number(org.recharge_reserved_inr) || 0)),
    gcpVertexProject: await db.toApiOrgCloudProject(await db.getOrgCloudProject(orgId)),
    settings: org.settings || {},
    counts: { leads: leadCount || 0, workflows: workflowCount || 0, campaigns: campaignCount || 0, members: (members || []).length },
    members: (members || []).map((m) => ({
      id: m.id, name: m.name, email: m.email, role: m.role, status: m.status, hasAccount: !!m.user_id, createdAt: m.created_at
    })),
    recentCalls: await Promise.all((calls || []).map(async (c) => ({
      id: c.id, callerNumber: c.lead_name || null, agentName: null, durationSeconds: c.duration || null,
      sentiment: c.sentiment, createdAt: c.created_at
    }))),
    recentActivity: (activity || []).map((a) => ({
      id: a.id, actorEmail: a.actor_email, action: a.action, metadata: a.metadata, createdAt: a.created_at
    }))
  };
}

async function getPricing() {
  return {
    // Derived live from the active call provider on the Cost page — see
    // platform/pricing.js's getCostPerMinuteInr. Not settable here.
    costPerMinuteInr: await getCostPerMinuteInr(),
    phoneCostPerMinute: await getPhoneCostPerMinute(),
  };
}

async function updatePricing(actor, phoneCostPerMinute) {
  const result = {};
  if (phoneCostPerMinute !== undefined) {
    result.phoneCostPerMinute = await setPhoneCostPerMinute(phoneCostPerMinute);
    await auditLog.record(null, actor, "platform.pricing.update", "pricing", "phone_cost_per_minute", { phoneCostPerMinute: result.phoneCostPerMinute });
  }
  return result;
}

// ── Cost providers (per-provider call/AI rates + tax, see costProviders.js) ──
// Every provider is defined in code (costProviders.js's KNOWN_PROVIDERS) —
// only rate/tax/active can be adjusted here, never created or deleted.
async function listCostProviders() {
  return costProviders.listProviders();
}

async function upsertCostProvider(actor, input) {
  return costProviders.upsertProvider(actor, input || {});
}

async function getFeatureFlags() {
  return featureFlags.listAllFlags();
}

async function updateFeatureFlag(actor, flag, enabled) {
  if (featureFlags.APP_FEATURE_DEFINITIONS[flag]) {
    await featureFlags.setAppFeatureEnabled(flag, enabled);
  } else {
    await featureFlags.setEnabled(flag, enabled);
  }
  await auditLog.record(null, actor, "platform.feature.update", "feature_flag", flag, { enabled: !!enabled });
  return { key: flag, enabled: !!enabled, globallyEnabled: !!enabled };
}

async function getFeatureGroups() {
  return featureFlags.getFeatureGroups();
}

async function saveFeatureGroup(group) {
  return featureFlags.upsertFeatureGroup(group);
}

async function deleteFeatureGroup(key) {
  return featureFlags.deleteFeatureGroup(key);
}

async function sanitizeFeatureKeys(keys) {
  return featureFlags.sanitizeFeatureKeys(keys);
}

async function getDataRetentionDefaults() {
  return dataRetention.getPlatformDefaults();
}

async function setDataRetentionDefaults(actor, policy) {
  const result = await dataRetention.setPlatformDefaults(policy);
  await auditLog.record(null, actor, "platform.retention.defaults.update", "data_retention", "defaults", { policy: result });
  return result;
}

async function getOrganizationDataRetention(orgId) {
  return dataRetention.getOrgPolicy(orgId);
}

async function setOrganizationDataRetention(actor, orgId, input) {
  const result = await dataRetention.setOrgPolicy(orgId, input);
  await auditLog.record(null, actor, "platform.org.retention.update", "data_retention", orgId, { mode: result.mode, policy: result.policy });
  return result;
}

async function setOrganizationBackup(actor, orgId, input) {
  const result = await dataRetention.setOrgBackup(orgId, input);
  await auditLog.record(null, actor, "platform.org.backup.update", "data_backup", orgId, { backup: result });
  return result;
}

async function previewOrganizationRetention(orgId) {
  return dataRetention.previewOrg(orgId);
}

async function requestOrganizationBackup(actor, orgId) {
  const result = await dataRetention.requestBackup(orgId);
  await auditLog.record(null, actor, "platform.org.backup.request", "data_backup", orgId, result);
  return result;
}

async function getOrganizationBackupStatus(orgId) {
  return dataRetention.getBackupStatus(orgId);
}

// Hard-deletes an organization and all of its data across every table.
// Called only by platform admins after a name-confirmation step.
//
// Before touching anything, this snapshots the org's final cost/billing
// figures into org_cost_archive (crm/billingEngine.js's
// getFinalBillingSnapshot + db.archiveOrgCost) — a table this function
// never deletes from. Without that, deleting the organizations row (which
// holds the accrued ai_minutes_used/phone_charges counters) plus every
// call_logs/inbound_call_logs/calls row below would make that org's
// entire cost history unrecoverable the instant it's deleted. If the
// snapshot itself fails, the whole deletion is aborted — losing the
// financial record is worse than a slower/retried delete.
async function deleteOrganization(orgId, actor) {
  const billingEngine = require("../crm/billingEngine");
  const snapshot = await billingEngine.getFinalBillingSnapshot(orgId);
  if (!snapshot) {
    log.warn(`[deleteOrganization] no org found for ${orgId} — aborting deletion`);
    throw new Error(`Organization ${orgId} was not found`);
  }

  // Archive + tenant deletion happen in one database transaction.
  // This prevents a billing archive from existing when the delete rolls back.
  await db.deleteOrganizationData(orgId, snapshot, actor?.userEmail);

  await auditLog.record(null, actor, "platform.org.cost_archived", "cost_archive", orgId, {
    aiMinutesUsed: snapshot.aiMinutesUsed, phoneCharges: snapshot.phoneCharges,
    aiTotalTokens: snapshot.aiTokenUsage?.totalTokens ?? 0,
  });

}

async function listCostArchive() {
  return db.listCostArchive();
}

module.exports = {
  listOrganizations, listUsers, listAuditLog, getStats, getTimeSeries, getOrganizationDetail,
  getPricing, updatePricing, getFeatureFlags, updateFeatureFlag, deleteOrganization,
  listCostProviders, upsertCostProvider, listCostArchive,
  getFeatureGroups, saveFeatureGroup, deleteFeatureGroup, sanitizeFeatureKeys,
  getDataRetentionDefaults, setDataRetentionDefaults, getOrganizationDataRetention,
  setOrganizationDataRetention, setOrganizationBackup, previewOrganizationRetention,
  requestOrganizationBackup, getOrganizationBackupStatus,
};
