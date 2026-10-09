// ============================================================
// Data retention + organization backup service.
// Policies live in platform_settings (platform defaults) and the
// organization's existing settings JSON (per-org overrides).
// ============================================================

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const db = require("../db/repository");
const workspaces = require("../db/repositories/workspaceRepository");
const { runWithScope } = require("../workspaces/scope");
const platformSettings = require("./settings");
const storage = require("../storage");
const { getClient } = require("../storage/client");
const mailer = require("../email/mailer");
const emailTemplates = require("../email/templates");
const auditLog = require("./auditLog");
const { getLogger } = require("../observability/logger");
const log = getLogger("platform.data-retention");

const execFileAsync = promisify(execFile);

const DATA_TYPES = {
  call_recordings: { label: "Call recordings", defaultDays: 365 },
  transcripts: { label: "Call transcripts", defaultDays: 365 },
  ai_summaries: { label: "AI summaries", defaultDays: 730 },
  call_logs: { label: "Call logs", defaultDays: 730 },
  campaign_history: { label: "Campaign history", defaultDays: 365 },
  audit_logs: { label: "Audit logs", defaultDays: 730 },
  documents: { label: "Uploaded documents", defaultDays: 365 },
  contacts: { label: "Contacts", defaultDays: 365 },
};

const DEFAULT_POLICY = Object.fromEntries(
  Object.entries(DATA_TYPES).map(([key, value]) => [key, value.defaultDays])
);

const PLATFORM_KEY = "data_retention.defaults";
const ORG_KEY = "dataRetention";
const BACKUP_KEY = "dataBackup";
const BACKUP_DEFAULTS = {
  enabled: false,
  frequency: "monthly",
  email: "",
  retentionDays: 365,
};

function normalizeDays(value) {
  if (value === null || value === undefined || value === "" || value === "never") return null;
  const days = Math.floor(Number(value));
  if (!Number.isFinite(days) || days < 1 || days > 3650) throw new Error("Retention must be between 1 and 3650 days, or Never.");
  return days;
}

function normalizePolicy(input, base = DEFAULT_POLICY) {
  const result = { ...base };
  for (const key of Object.keys(DATA_TYPES)) {
    if (Object.prototype.hasOwnProperty.call(input || {}, key)) {
      result[key] = normalizeDays(input[key]);
    }
  }
  return result;
}

const CATALOG_KEY = "data_retention.policy_catalog";
const DEFAULT_TEMPLATE_ID = "platform-default";
function policyError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function normalizeBackupTemplate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.enabled !== "boolean")
    throw policyError("Provide valid backup settings for every policy.");
  const frequency = String(input.frequency || "");
  if (!["daily", "weekly", "monthly"].includes(frequency))
    throw policyError("Backup frequency must be daily, weekly, or monthly.");
  const retentionDays = Number(input.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)
    throw policyError("Backup retention must be 1–3650 days.");
  return { enabled: input.enabled, frequency, retentionDays };
}
function normalizeTemplate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw policyError("Each policy needs a name, retention, and backup configuration.");
  const id = String(input.id || "").trim();
  const name = String(input.name || "").trim();
  const description = String(input.description || "").trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw policyError("Invalid policy ID.");
  if (!name || name.length > 100) throw policyError("Policy names must be 1–100 characters.");
  if (description.length > 300) throw policyError("Policy descriptions must be at most 300 characters.");
  if (!input.retention || typeof input.retention !== "object" || Array.isArray(input.retention))
    throw policyError("Retention periods must be an object.");
  let retention;
  try { retention = normalizePolicy(input.retention, DEFAULT_POLICY); }
  catch (err) { throw policyError(err.message); }
  return { id, name, description, retention, backup: normalizeBackupTemplate(input.backup) };
}

async function getLegacyDefaults() {
  const stored = await platformSettings.getSetting(PLATFORM_KEY, null);
  // Preserve the original migration away from an unconfigured all-Never policy.
  if (!stored || (typeof stored === "object" && Object.keys(DATA_TYPES).every(key => stored[key] == null))) {
    await platformSettings.setSetting(PLATFORM_KEY, DEFAULT_POLICY);
    return { ...DEFAULT_POLICY };
  }
  return normalizePolicy(stored, DEFAULT_POLICY);
}
async function getPolicyCatalog() {
  const stored = await platformSettings.getSetting(CATALOG_KEY, null);
  if (stored) {
    if (!Array.isArray(stored.policies) || !stored.policies.length ||
        !stored.policies.some(row => row.id === stored.defaultPolicyId))
      throw new Error("The saved retention and backup policy catalog is invalid.");
    return stored;
  }
  return { version: 0, defaultPolicyId: DEFAULT_TEMPLATE_ID, policies: [{
    id: DEFAULT_TEMPLATE_ID, name: "Platform default",
    description: "Default data retention and backup settings for new organizations.",
    retention: await getLegacyDefaults(),
    backup: { enabled: false, frequency: "monthly", retentionDays: 365 },
  }] };
}
async function setPolicyCatalog(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw policyError("Provide a policy catalog.");
  const current = await getPolicyCatalog();
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== current.version)
    throw policyError("Policies changed since you opened this page. Reload before saving.", 409);
  if (!Array.isArray(input.policies) || input.policies.length < 1 || input.policies.length > 50)
    throw policyError("Keep between 1 and 50 policies.");
  const policies = input.policies.map(normalizeTemplate);
  if (new Set(policies.map(p => p.id)).size !== policies.length)
    throw policyError("Policy IDs must be unique.");
  if (new Set(policies.map(p => p.name.toLowerCase())).size !== policies.length)
    throw policyError("Policy names must be unique.");
  const defaultPolicyId = String(input.defaultPolicyId || "");
  const selectedDefault = policies.find(row => row.id === defaultPolicyId);
  if (!selectedDefault) throw policyError("Choose one default policy.");
  if (!policies.some(row => row.id === current.defaultPolicyId))
    throw policyError("Set a new default before deleting the previous default.");
  const next = { version: current.version + 1, defaultPolicyId, policies };
  await platformSettings.setSetting(CATALOG_KEY, next);
  await platformSettings.setSetting(PLATFORM_KEY, selectedDefault.retention);
  return next;
}
async function resolveRetentionTemplate(policyId, adminEmail, expectedVersion) {
  const catalog = await getPolicyCatalog();
  if (expectedVersion !== undefined && expectedVersion !== catalog.version)
    throw policyError("Retention and backup policies changed. Reload before creating the organization.", 409);
  const id = policyId == null ? catalog.defaultPolicyId : String(policyId).trim();
  const policy = catalog.policies.find(row => row.id === id);
  if (!policy) throw policyError("Selected retention and backup policy no longer exists.", 409);
  const email = String(adminEmail || "").trim().toLowerCase();
  if (policy.backup.enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw policyError("An organization admin email is required when automated backups are enabled.");
  return {
    policyId: policy.id, policyName: policy.name,
    retention: normalizePolicy(policy.retention, DEFAULT_POLICY),
    backup: {
      enabled: policy.backup.enabled,
      frequency: policy.backup.frequency,
      retentionDays: policy.backup.retentionDays,
      email: policy.backup.enabled ? email : "",
    },
  };
}
async function getPlatformDefaults() {
  const stored = await platformSettings.getSetting(CATALOG_KEY, null);
  if (stored) {
    const def = stored.policies?.find(row => row.id === stored.defaultPolicyId);
    if (!def) throw new Error("Retention policy default is not configured.");
    return normalizePolicy(def.retention, DEFAULT_POLICY);
  }
  return getLegacyDefaults();
}
async function setPlatformDefaults(policy) {
  const normalized = normalizePolicy(policy, DEFAULT_POLICY);
  const stored = await platformSettings.getSetting(CATALOG_KEY, null);
  if (stored) {
    const updated = await setPolicyCatalog({
      expectedVersion: stored.version,
      defaultPolicyId: stored.defaultPolicyId,
      policies: stored.policies.map(row => row.id === stored.defaultPolicyId
        ? { ...row, retention: normalized } : row),
    });
    return updated.policies.find(row => row.id === updated.defaultPolicyId).retention;
  }
  await platformSettings.setSetting(PLATFORM_KEY, normalized);
  return normalized;
}

function extractOrgSettings(org) {
  // Worker queries return a raw settings column. db.getOrg() returns the
  // flattened API object (dataRetention/dataBackup at top level).
  let settings = org?.settings;
  if (typeof settings === "string") {
    try { settings = JSON.parse(settings); } catch { settings = {}; }
  }
  if (settings && typeof settings === "object" && !Array.isArray(settings)) return settings;
  return {
    ...(org?.dataRetention !== undefined ? { [ORG_KEY]: org.dataRetention } : {}),
    ...(org?.dataBackup !== undefined ? { [BACKUP_KEY]: org.dataBackup } : {}),
  };
}

async function getOrgPolicy(orgId) {
  const org = await db.getOrg(orgId);
  if (!org) throw new Error("Organization not found");
  const defaults = await getPlatformDefaults();
  const settings = extractOrgSettings(org);
  const retention = settings[ORG_KEY] || {};
  const mode = retention.mode === "custom" ? "custom" : "default";
  const overrides = mode === "custom" ? normalizePolicy(retention.overrides || {}, defaults) : {};
  const policy = mode === "custom" ? overrides : defaults;
  return {
    organizationId: orgId,
    mode,
    policy,
    policyId: retention.policyId || null,
    policyName: retention.policyName || null,
    defaults,
    overrides: mode === "custom" ? overrides : {},
    backup: { ...BACKUP_DEFAULTS, ...(settings[BACKUP_KEY] || {}) },
  };
}

async function setOrgPolicy(orgId, { mode = "default", overrides = {} } = {}) {
  const org = await db.getOrg(orgId);
  if (!org) throw new Error("Organization not found");
  const defaults = await getPlatformDefaults();
  const normalizedMode = mode === "custom" ? "custom" : "default";
  const normalizedOverrides = normalizedMode === "custom" ? normalizePolicy(overrides, defaults) : {};
  const settings = extractOrgSettings(org);
  settings[ORG_KEY] = { mode: normalizedMode, overrides: normalizedOverrides, updatedAt: new Date().toISOString() };
  const updated = await db.updateOrg(orgId, { dataRetention: settings[ORG_KEY] });
  return {
    organizationId: orgId,
    mode: normalizedMode,
    policy: normalizedMode === "custom" ? normalizedOverrides : defaults,
    defaults,
    overrides: normalizedOverrides,
    backup: { ...BACKUP_DEFAULTS, ...(settings[BACKUP_KEY] || {}) },
    organization: updated,
  };
}

async function setOrgBackup(orgId, input) {
  const org = await db.getOrg(orgId);
  if (!org) throw new Error("Organization not found");
  const settings = extractOrgSettings(org);
  const current = { ...BACKUP_DEFAULTS, ...(settings[BACKUP_KEY] || {}) };
  const next = {
    ...current,
    enabled: !!input.enabled,
    frequency: ["daily", "weekly", "monthly"].includes(input.frequency) ? input.frequency : current.frequency,
    email: String(input.email || current.email || "").trim(),
    retentionDays: normalizeDays(input.retentionDays ?? current.retentionDays) || 365,
  };
  if (next.enabled && !next.email) throw new Error("Backup email is required when backups are enabled.");
  settings[BACKUP_KEY] = { ...next, updatedAt: new Date().toISOString() };
  await db.updateOrg(orgId, { dataBackup: settings[BACKUP_KEY] });
  return next;
}

function cutoffForDays(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function storageKeyFromValue(value) {
  return storage.recordingObjectKey(value);
}

async function deleteRecording(value) {
  const key = storageKeyFromValue(value);
  if (!key) return false;
  try {
    await storage.remove(key);
    return true;
  } catch (err) {
    log.warn(`[retention] S3 delete failed for ${key}: ${err.message}`);
    return false;
  }
}

async function purgeCallRecordings(orgId, cutoff) {
  const { data, error } = await db.supabase.from("call_logs")
    .select("id, recording_url").eq("org_id", orgId).lt("created_at", cutoff).not("recording_url", "is", null).limit(500);
  if (error) throw error;
  let deleted = 0, failed = 0;
  for (const row of data || []) {
    const ok = await deleteRecording(row.recording_url);
    if (ok) {
      const { error: updateError } = await db.supabase.from("call_logs").update({ recording_url: null }).eq("id", row.id).eq("org_id", orgId);
      if (updateError) throw updateError;
      deleted++;
    } else failed++;
  }
  return { deleted, failed };
}

async function nullField(table, field, orgId, cutoff) {
  const { data, error } = await db.supabase.from(table).select("id")
    .eq("org_id", orgId).lt("created_at", cutoff).not(field, "is", null).limit(500);
  if (error) {
    if (/does not exist|unknown column|not found/i.test(error.message || "")) return 0;
    throw error;
  }
  if (!data?.length) return 0;
  const ids = data.map(r => r.id);
  const { error: updateError } = await db.supabase.from(table).update({ [field]: null }).in("id", ids).eq("org_id", orgId);
  if (updateError) throw updateError;
  return ids.length;
}

async function deleteRows(table, orgId, cutoff, limit = 500) {
  const { data, error } = await db.supabase.from(table).select("id")
    .eq("org_id", orgId).lt("created_at", cutoff).limit(limit);
  if (error) {
    if (/does not exist|unknown column|not found/i.test(error.message || "")) return 0;
    throw error;
  }
  if (!data?.length) return 0;
  const ids = data.map(r => r.id);
  const { error: delError } = await db.supabase.from(table).delete().in("id", ids).eq("org_id", orgId);
  if (delError) throw delError;
  return ids.length;
}

async function runRetentionForWorkspace(orgId, state, { dryRun = false } = {}) {
  const counts = {};
  for (const [type, days] of Object.entries(state.policy)) {
    if (days === null) { counts[type] = 0; continue; }
    const cutoff = cutoffForDays(days);
    if (dryRun) {
      const tableMap = {
        call_recordings: ["call_logs"],
        transcripts: ["call_logs", "inbound_call_logs"],
        ai_summaries: ["call_logs", "inbound_call_logs"],
        call_logs: ["call_logs", "inbound_call_logs"],
        campaign_history: ["campaigns"],
        audit_logs: ["audit_log"],
        documents: ["loans"],
        contacts: ["leads"],
      };
      let total = 0;
      for (const table of (tableMap[type] || [])) {
        const { data, error } = await db.supabase.from(table).select("id").eq("org_id", orgId).lt("created_at", cutoff).limit(5000);
        if (!error) total += data?.length || 0;
      }
      counts[type] = total;
      continue;
    }
    if (type === "call_recordings") counts[type] = await purgeCallRecordings(orgId, cutoff);
    else if (type === "transcripts") counts[type] = {
      callLogs: await nullField("call_logs", "transcript", orgId, cutoff),
      inboundCallLogs: await nullField("inbound_call_logs", "transcript", orgId, cutoff),
    };
    else if (type === "ai_summaries") counts[type] = {
      callLogs: await nullField("call_logs", "summary", orgId, cutoff),
      inboundCallLogs: await nullField("inbound_call_logs", "summary", orgId, cutoff),
    };
    else if (type === "call_logs") counts[type] = {
      callLogs: await deleteRows("call_logs", orgId, cutoff),
      inboundCallLogs: await deleteRows("inbound_call_logs", orgId, cutoff),
    };
    else if (type === "campaign_history") counts[type] = await deleteRows("campaigns", orgId, cutoff);
    else if (type === "audit_logs") counts[type] = await deleteRows("audit_log", orgId, cutoff);
    else if (type === "contacts") counts[type] = await deleteRows("leads", orgId, cutoff);
    else if (type === "documents") {
      // Documents are often embedded in loan JSON; remove the document payload
      // while preserving the financial/loan record itself.
      counts[type] = await nullField("loans", "documents", orgId, cutoff);
    }
  }
  return { organizationId: orgId, dryRun, policy: state.policy, counts, completedAt: new Date().toISOString() };
}

async function runRetentionForOrg(orgId, { dryRun = false } = {}) {
  const state = await getOrgPolicy(orgId);
  const workspaceResults = [];
  const counts = {};
  function addCounts(target, source) {
    for (const [key,value] of Object.entries(source)) {
      if (typeof value === 'number') target[key] = (target[key] || 0) + value;
      else if (value && typeof value === 'object') addCounts(target[key] ||= {}, value);
    }
  }
  // Retention is an organization policy. Include suspended workspaces too;
  // suspension must not make expired data exempt from that policy.
  for (const workspace of await workspaces.listForOrg(orgId)) {
    const result = await runWithScope({ orgId, workspaceId: workspace.id }, () =>
      runRetentionForWorkspace(orgId, state, { dryRun }));
    workspaceResults.push({ workspaceId: workspace.id, counts: result.counts });
    addCounts(counts, result.counts);
  }
  return { organizationId: orgId, dryRun, policy: state.policy, counts,
    workspaces: workspaceResults, completedAt: new Date().toISOString() };
}

async function listOrganizationsForWorker() {
  const { data, error } = await db.supabase.from("organizations").select("id, name, settings");
  if (error) throw error;
  return data || [];
}

async function nextBackupDue(backup) {
  if (!backup?.enabled) return false;
  const last = backup.lastCompletedAt ? new Date(backup.lastCompletedAt).getTime() : 0;
  const now = Date.now();
  const interval = backup.frequency === "daily" ? 86400000 : backup.frequency === "weekly" ? 7 * 86400000 : 30 * 86400000;
  return now - last >= interval;
}

async function writeJsonFile(filePath, value) {
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function downloadObjectToFile(key, filePath) {
  const response = await getClient().send(new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: key }));
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    response.Body.pipe(out);
    response.Body.once("error", reject);
    out.once("error", reject);
    out.once("finish", resolve);
  });
}

const BACKUP_PAGE_SIZE = 500;

async function writeOrgTableBackup(client, table, orgId, filePath) {
  if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error("Invalid backup table name");
  const { rows: keyRows } = await client.query(
    `SELECT COLUMN_NAME AS column_name FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`, [table]);
  const primaryKey = (keyRows || []).map(row => String(row.column_name || ""));
  if (!primaryKey.length || primaryKey.some(column => !/^[a-zA-Z0-9_]+$/.test(column))) {
    throw new Error(`Table ${table} has no usable primary key for a consistent paged backup`);
  }

  const orderBy = primaryKey.map(column => `\`${column}\``).join(", ");
  const cursorPredicate = primaryKey.length === 1
    ? `\`${primaryKey[0]}\` > ?`
    : `(${orderBy}) > (${primaryKey.map(() => "?").join(", ")})`;
  let cursor = null;
  let rowCount = 0;
  let first = true;
  await fsp.writeFile(filePath, "[", "utf8");

  while (true) {
    const sql = cursor
      ? `SELECT * FROM \`${table}\` WHERE org_id = ? AND ${cursorPredicate} ORDER BY ${orderBy} LIMIT ?`
      : `SELECT * FROM \`${table}\` WHERE org_id = ? ORDER BY ${orderBy} LIMIT ?`;
    const params = cursor ? [orgId, ...cursor, BACKUP_PAGE_SIZE] : [orgId, BACKUP_PAGE_SIZE];
    const { rows } = await client.query(sql, params);
    if (!rows?.length) break;

    const serialized = rows.map(row => JSON.stringify(row));
    await fsp.appendFile(filePath, `${first ? "" : ","}${serialized.join(",")}`, "utf8");
    first = false;
    rowCount += rows.length;
    cursor = primaryKey.map(column => rows[rows.length - 1][column]);
    if (rows.length < BACKUP_PAGE_SIZE) break;
  }

  await fsp.appendFile(filePath, "]", "utf8");
  return rowCount;
}

async function exportOrgBackup(orgId, orgName, backupConfig) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `crm-backup-${orgId}-`));
  const dataDir = path.join(root, "data");
  const recordingsDir = path.join(root, "recordings");
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(recordingsDir, { recursive: true });

  try {
    const manifest = {
      organizationId: orgId,
      organizationName: orgName,
      createdAt: new Date().toISOString(),
      format: "crm-backup-v2",
      scope: "organization-all-workspaces",
      workspaces: (await workspaces.listForOrg(orgId)).map(w => ({ id: w.id, name: w.name, status: w.status })),
      note: "Generated by the CRM retention/backup service.",
    };
    await writeJsonFile(path.join(root, "manifest.json"), manifest);

    const exportedTables = [];
    let recordings = [];
    const snapshotClient = await db.pool.connect();
    try {
      await snapshotClient.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await snapshotClient.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      const { rows: tableResult } = await snapshotClient.query(
        "SELECT DISTINCT TABLE_NAME AS table_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'org_id' ORDER BY TABLE_NAME"
      );

      for (const row of tableResult || []) {
        const table = String(row.table_name || "");
        if (!/^[a-zA-Z0-9_]+$/.test(table)) continue;
        try {
          const count = await writeOrgTableBackup(snapshotClient, table, orgId, path.join(dataDir, `${table}.json`));
          exportedTables.push({ table, rows: count });
        } catch (err) {
          throw new Error(`Backup of ${table} failed: ${err.message}`);
        }
      }

      const { rows: cloudProjects } = await snapshotClient.query(
        "SELECT * FROM organization_cloud_projects WHERE organization_id = ?", [orgId]);
      await writeJsonFile(path.join(dataDir, "organization_cloud_projects.json"), cloudProjects || []);
      exportedTables.push({ table: "organization_cloud_projects", rows: cloudProjects?.length || 0 });

      const { rows: orgRows } = await snapshotClient.query("SELECT * FROM organizations WHERE id = ?", [orgId]);
      await writeJsonFile(path.join(dataDir, "organization.json"), orgRows?.[0] || null);

      // This is deliberately organization-wide, including suspended workspaces.
      // The recording manifest is read from the same consistent snapshot as
      // the exported tables before storage objects are downloaded.
      const recordingResult = await snapshotClient.query(`SELECT id,recording_url,created_at,
        COALESCE(workspace_id,org_id) AS workspace_id FROM call_logs
        WHERE org_id=? AND recording_url IS NOT NULL ORDER BY id`, [orgId]);
      recordings = recordingResult.rows || [];
      await snapshotClient.query("COMMIT");
    } catch (err) {
      try { await snapshotClient.query("ROLLBACK"); } catch (_) {}
      throw err;
    } finally {
      snapshotClient.release();
    }

    const recordingManifest = [];
    for (const row of recordings) {
      const key = storage.recordingObjectKey(row.recording_url, { orgId, workspaceId: row.workspace_id || orgId });
      if (!key) continue;
      const workspaceName = String(row.workspace_id || orgId).replace(/[^a-zA-Z0-9_-]/g, "_");
      const safeName = `${workspaceName}-${String(row.id).replace(/[^a-zA-Z0-9_-]/g, "_")}` + path.extname(key || ".audio");
      try {
        const target = path.join(recordingsDir, safeName);
        await downloadObjectToFile(key, target);
        recordingManifest.push({ workspaceId: row.workspace_id, callId: row.id, createdAt: row.created_at, file: `recordings/${safeName}` });
      } catch (err) {
        recordingManifest.push({ workspaceId: row.workspace_id, callId: row.id, error: err.message });
      }
    }
    await writeJsonFile(path.join(root, "table-manifest.json"), exportedTables);
    await writeJsonFile(path.join(root, "recording-manifest.json"), recordingManifest);
    await writeJsonFile(path.join(root, "retention-policy.json"), await getOrgPolicy(orgId));

    const zipName = `${orgId}-crm-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
    const zipPath = root + ".zip";
    await execFileAsync("zip", ["-qr", zipPath, "."], { cwd: root, maxBuffer: 1024 * 1024 });
    const key = `backups/${orgId}/${zipName}`;
    const stat = await fsp.stat(zipPath);
    await storage.upload(key, fs.createReadStream(zipPath), { contentType: "application/zip" });
    const downloadUrl = await storage.signedUrl(key, 7 * 86400);
    const backupRecord = { key, createdAt: new Date().toISOString(), sizeBytes: stat.size };
    return { key, zipName, sizeBytes: stat.size, downloadUrl, backupRecord };
  } finally {
    await fsp.rm(root + ".zip", { force: true }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function updateBackupState(orgId, patch) {
  const org = await db.getOrg(orgId);
  if (!org) return;
  const settings = extractOrgSettings(org);
  settings[BACKUP_KEY] = { ...BACKUP_DEFAULTS, ...(settings[BACKUP_KEY] || {}), ...patch };
  await db.updateOrg(orgId, { dataBackup: settings[BACKUP_KEY] });
}

async function purgeExpiredBackups(orgId, retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  try {
    const response = await getClient().send(new ListObjectsV2Command({
      Bucket: process.env.STORAGE_BUCKET,
      Prefix: `backups/${orgId}/`,
    }));
    let deleted = 0;
    for (const object of response.Contents || []) {
      if (object.LastModified && object.LastModified.getTime() < cutoff && object.Key) {
        await storage.remove(object.Key);
        deleted++;
      }
    }
    return deleted;
  } catch (err) {
    log.warn(`[backup] Could not purge expired backups for ${orgId}: ${err.message}`);
    return 0;
  }
}

async function performBackup(org) {
  const settings = extractOrgSettings(org);
  const config = { ...BACKUP_DEFAULTS, ...(settings[BACKUP_KEY] || {}) };
  if (!config.enabled && !config.requestedAt) return null;
  if (!config.email) {
    await updateBackupState(org.id, { lastStatus: "failed", lastError: "Backup email is not configured." });
    return null;
  }
  await updateBackupState(org.id, { lastStatus: "running", lastStartedAt: new Date().toISOString(), requestedAt: null });
  try {
    const result = await exportOrgBackup(org.id, org.name, config);
    await updateBackupState(org.id, {
      lastStatus: "completed",
      lastCompletedAt: new Date().toISOString(),
      lastError: null,
      lastDownloadUrl: result.downloadUrl,
      lastBackup: result.backupRecord,
    });
    const template = emailTemplates.backupReadyEmail({ downloadUrl: result.downloadUrl,
      retentionText: `The private download link expires in 7 days. Backup size: ${Math.round(result.sizeBytes / 1024 / 1024 * 100) / 100} MB.` });
    await mailer.sendMail({ to: config.email, ...template });
    await purgeExpiredBackups(org.id, config.retentionDays || 365);
    return result;
  } catch (err) {
    log.error(`[backup] ${org.id} failed: ${err.message}`);
    await updateBackupState(org.id, { lastStatus: "failed", lastError: err.message });
    return null;
  }
}

async function runRetentionCycle() {
  const orgs = await listOrganizationsForWorker();
  const results = [];
  for (const org of orgs) {
    try {
      const state = await getOrgPolicy(org.id);
      if (Object.values(state.policy).some(days => days !== null)) {
        results.push(await runRetentionForOrg(org.id));
      }
      const settings = extractOrgSettings(org);
      const backup = { ...BACKUP_DEFAULTS, ...(settings[BACKUP_KEY] || {}) };
      if (backup.requestedAt || await nextBackupDue(backup)) {
        results.push({ organizationId: org.id, backup: await performBackup(org) });
      }
    } catch (err) {
      log.error(`[retention] org ${org.id} failed: ${err.message}`);
    }
  }
  return results;
}

async function previewOrg(orgId) {
  return runRetentionForOrg(orgId, { dryRun: true });
}

async function requestBackup(orgId) {
  const org = await db.getOrg(orgId);
  if (!org) throw new Error("Organization not found");
  const settings = extractOrgSettings(org);
  const config = { ...BACKUP_DEFAULTS, ...(settings[BACKUP_KEY] || {}) };
  if (!config.email) throw new Error("Configure a backup email before requesting a backup.");
  await updateBackupState(orgId, { requestedAt: new Date().toISOString(), lastStatus: "queued", lastError: null });
  return { queued: true, email: config.email };
}

async function getBackupStatus(orgId) {
  const org = await db.getOrg(orgId);
  if (!org) throw new Error("Organization not found");
  const settings = extractOrgSettings(org);
  const config = { ...BACKUP_DEFAULTS, ...(settings[BACKUP_KEY] || {}) };
  return {
    enabled: !!config.enabled,
    frequency: config.frequency,
    email: config.email,
    retentionDays: config.retentionDays,
    lastStatus: config.lastStatus || "never",
    lastStartedAt: config.lastStartedAt || null,
    lastCompletedAt: config.lastCompletedAt || null,
    lastError: config.lastError || null,
    lastBackup: config.lastBackup || null,
  };
}

module.exports = {
  DATA_TYPES,
  DEFAULT_POLICY,
  BACKUP_DEFAULTS,
  getPolicyCatalog,
  setPolicyCatalog,
  resolveRetentionTemplate,
  getPlatformDefaults,
  setPlatformDefaults,
  getOrgPolicy,
  setOrgPolicy,
  setOrgBackup,
  runRetentionForOrg,
  previewOrg,
  requestBackup,
  getBackupStatus,
  runRetentionCycle,
};
