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

async function getPlatformDefaults() {
  const stored = await platformSettings.getSetting(PLATFORM_KEY, null);

  // Migrate the original "all Never" platform policy to the defined defaults.
  // Once an admin changes a value (including intentionally choosing Never),
  // that stored policy is respected normally.
  if (!stored || (typeof stored === "object" && Object.keys(DATA_TYPES).every((key) => stored[key] == null))) {
    await platformSettings.setSetting(PLATFORM_KEY, DEFAULT_POLICY);
    return { ...DEFAULT_POLICY };
  }

  return normalizePolicy(stored, DEFAULT_POLICY);
}

async function setPlatformDefaults(policy) {
  const normalized = normalizePolicy(policy, DEFAULT_POLICY);
  await platformSettings.setSetting(PLATFORM_KEY, normalized);
  return normalized;
}

function extractOrgSettings(org) {
  let settings = org?.settings || {};
  if (typeof settings === "string") {
    try { settings = JSON.parse(settings); } catch { settings = {}; }
  }
  return settings && typeof settings === "object" ? settings : {};
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

    const { rows: tableResult } = await db.pool.query(
      "SELECT DISTINCT TABLE_NAME AS table_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'org_id'"
    );

    const exportedTables = [];
    for (const row of tableResult || []) {
      const table = String(row.table_name || "");
      if (!/^[a-zA-Z0-9_]+$/.test(table)) continue;
      try {
        const { rows } = await db.pool.query(`SELECT * FROM \`${table}\` WHERE org_id = ?`, [orgId]);
        await writeJsonFile(path.join(dataDir, `${table}.json`), rows || []);
        exportedTables.push({ table, rows: rows?.length || 0 });
      } catch (err) {
        throw new Error(`Backup of ${table} failed: ${err.message}`);
      }
    }

    const { data: org } = await db.supabase.from("organizations").select("*").eq("id", orgId).maybeSingle();
    await writeJsonFile(path.join(dataDir, "organization.json"), org || null);

    // This is deliberately organization-wide, including suspended workspaces.
    // Request-local operational scope must not silently truncate an org backup.
    const { rows: recordings } = await db.pool.query(`SELECT id,recording_url,created_at,
      COALESCE(workspace_id,org_id) AS workspace_id FROM call_logs
      WHERE org_id=? AND recording_url IS NOT NULL`, [orgId]);
    const recordingManifest = [];
    for (const row of recordings || []) {
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
    const subject = `${org.name} — CRM backup ready`;
    const html = `<p>Your CRM backup for <strong>${org.name}</strong> is ready.</p><p>Size: ${Math.round(result.sizeBytes / 1024 / 1024 * 100) / 100} MB</p><p><a href="${result.downloadUrl}">Download backup</a> (link expires in 7 days).</p>`;
    await mailer.sendMail({ to: config.email, subject, html, text: `Your CRM backup for ${org.name} is ready. Download: ${result.downloadUrl}` });
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
