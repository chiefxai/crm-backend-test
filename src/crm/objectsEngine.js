// ============================================================
// services/objectsEngine.js
//
// Generic "any industry" objects/fields/records/pipelines engine.
// See schema_part4_generic_objects.sql for the table shapes.
//
// Talks to db.supabase (services/mysqlClient.js), the same MySQL
// connection every other engine file uses — db.supabase is always
// configured (MySQL is required at startup), so requireDb() below
// never actually throws; kept as a defensive guard in case that ever
// changes.
// ============================================================

const db = require("../db/repository");
const { normalizePhone, normalizePhoneInput } = require("../lib/phone");

function requireDb() {
  if (!db.supabase) {
    const err = new Error("Custom objects require the database to be configured (MYSQL_URL).");
    err.statusCode = 503;
    throw err;
  }
}

// ------------------------------------------------------------
// Objects (+ nested fields/stages)
// ------------------------------------------------------------

// Returns every object for the org, each with its fields and stages
// nested, ordered by `position`.
async function listObjects(orgId) {
  requireDb();
  const { data: objects, error } = await db.supabase
    .from("objects")
    .select("*")
    .eq("org_id", orgId)
    .order("position", { ascending: true });
  if (error) throw new Error(`[objectsEngine.listObjects] ${error.message}`);
  if (!objects || !objects.length) return [];

  const objectIds = objects.map((o) => o.id);
  const [{ data: fields, error: fErr }, { data: stages, error: sErr }] = await Promise.all([
    db.supabase.from("object_fields").select("*").in("object_id", objectIds).order("position", { ascending: true }),
    db.supabase.from("object_stages").select("*").in("object_id", objectIds).order("position", { ascending: true })
  ]);
  if (fErr) throw new Error(`[objectsEngine.listObjects] fields: ${fErr.message}`);
  if (sErr) throw new Error(`[objectsEngine.listObjects] stages: ${sErr.message}`);

  return objects.map((o) => ({
    id: o.id,
    key: o.key,
    label: o.label,
    icon: o.icon,
    description: o.description,
    hasPipeline: o.has_pipeline,
    fields: (fields || []).filter((f) => f.object_id === o.id).map(fieldRowToApi),
    stages: (stages || []).filter((s) => s.object_id === o.id).map(stageRowToApi)
  }));
}

async function getObjectByKey(orgId, objectKey) {
  requireDb();
  const { data: object, error } = await db.supabase
    .from("objects")
    .select("*")
    .eq("org_id", orgId)
    .eq("key", objectKey)
    .maybeSingle();
  if (error) throw new Error(`[objectsEngine.getObjectByKey] ${error.message}`);
  if (!object) return null;

  const [{ data: fields, error: fErr }, { data: stages, error: sErr }] = await Promise.all([
    db.supabase.from("object_fields").select("*").eq("object_id", object.id).order("position", { ascending: true }),
    db.supabase.from("object_stages").select("*").eq("object_id", object.id).order("position", { ascending: true })
  ]);
  if (fErr) throw new Error(`[objectsEngine.getObjectByKey] fields: ${fErr.message}`);
  if (sErr) throw new Error(`[objectsEngine.getObjectByKey] stages: ${sErr.message}`);

  return {
    id: object.id,
    key: object.key,
    label: object.label,
    icon: object.icon,
    description: object.description,
    hasPipeline: object.has_pipeline,
    fields: (fields || []).map(fieldRowToApi),
    stages: (stages || []).map(stageRowToApi)
  };
}

// Creates an object plus its fields and stages in one call — this is what
// industry-pack seeding uses. spec: { key, label, icon?, description?,
// hasPipeline?, fields: [{key,label,type,options?,required?}],
// stages: [{key,label,color?}] }
async function createObject(orgId, spec) {
  requireDb();
  const { data: object, error } = await db.supabase
    .from("objects")
    .insert({
      org_id: orgId,
      key: spec.key,
      label: spec.label,
      icon: spec.icon || "Layers",
      description: spec.description || null,
      has_pipeline: spec.hasPipeline !== false,
      position: spec.position || 0
    })
    .select()
    .single();
  if (error) throw new Error(`[objectsEngine.createObject] ${error.message}`);

  const fields = spec.fields || [];
  const stages = spec.stages || [];

  if (fields.length) {
    const { error: fErr } = await db.supabase.from("object_fields").insert(
      fields.map((f, i) => ({
        org_id: orgId,
        object_id: object.id,
        key: f.key,
        label: f.label,
        type: f.type || "text",
        options: f.options || [],
        required: !!f.required,
        position: i
      }))
    );
    if (fErr) throw new Error(`[objectsEngine.createObject] fields: ${fErr.message}`);
  }

  if (stages.length) {
    const { error: sErr } = await db.supabase.from("object_stages").insert(
      stages.map((s, i) => ({
        org_id: orgId,
        object_id: object.id,
        key: s.key,
        label: s.label,
        color: s.color || "#6366f1",
        position: i
      }))
    );
    if (sErr) throw new Error(`[objectsEngine.createObject] stages: ${sErr.message}`);
  }

  return getObjectByKey(orgId, object.key);
}

function fieldRowToApi(row) {
  return { id: row.id, key: row.key, label: row.label, type: row.type, options: row.options, required: row.required };
}

function stageRowToApi(row) {
  return { id: row.id, key: row.key, label: row.label, color: row.color };
}

// ------------------------------------------------------------
// Records
// ------------------------------------------------------------

function recordRowToApi(row) {
  return { id: row.id, objectId: row.object_id, stageId: row.stage_id, createdAt: row.created_at, updatedAt: row.updated_at, ...row.data };
}

// Basic validation: every required field must be present and non-empty.
// Not full type coercion — this is a first cut, not a form-validation engine.
function validateAgainstFields(fields, data) {
  for (const f of fields) {
    if (f.required && (data[f.key] === undefined || data[f.key] === null || data[f.key] === "")) {
      const err = new Error(`Field "${f.label}" is required`);
      err.statusCode = 400;
      throw err;
    }
  }
}

async function listRecords(orgId, objectKey, options = {}) {
  const object = await getObjectByKey(orgId, objectKey);
  if (!object) {
    const err = new Error(`Object "${objectKey}" not found`);
    err.statusCode = 404;
    throw err;
  }
  const { page, limit } = options;
  const paginate = Number.isInteger(page) && Number.isInteger(limit) && page > 0 && limit > 0;
  let query = db.supabase
    .from("object_records")
    .select("*", paginate ? { count: "exact" } : undefined)
    .eq("org_id", orgId)
    .eq("object_id", object.id)
    .order("created_at", { ascending: false });
  if (paginate) {
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
  }
  const { data, error, count } = await query;
  if (error) throw new Error(`[objectsEngine.listRecords] ${error.message}`);
  const rows = (data || []).map(recordRowToApi);
  return paginate ? { rows, total: count ?? rows.length } : rows;
}

// Any of these keys, across every industry pack currently defined
// (services/industryPacks.js), is where a record's display name lives.
const NAME_FIELD_KEYS = ["name", "contactName", "customerName", "studentName"];

function extractRecordName(data) {
  for (const key of NAME_FIELD_KEYS) {
    if (data && data[key]) return data[key];
  }
  return null;
}

// Finds a saved contact/record whose data contains a phone value matching
// (last-10-digits) the given phone, so a call can be linked to an existing
// contact instead of showing up as a disconnected phone number with no
// history. Field keys for "phone" vary per industry pack (industryPacks.js
// — e.g. "phone", "parentPhone"), so this checks every string value in a
// record's data rather than assuming one fixed key name. Returns
// {id, name} (not just id) so the caller's saved name can also be used
// to greet them by name and skip re-asking for it.
async function findRecordByPhone(orgId, phone) {
  requireDb();
  const normalizedTarget = normalizePhone(phone);
  if (!normalizedTarget) return null;

  const { data: records, error } = await db.supabase
    .from("object_records")
    .select("*, object_id")
    .eq("org_id", orgId);
  if (error) throw new Error(`[objectsEngine.findRecordByPhone] ${error.message}`);

  for (const row of records || []) {
    const values = Object.values(row.data || {});
    const matches = values.some((v) => typeof v === "string" && normalizePhone(v) === normalizedTarget);
    if (matches) return { id: row.id, name: extractRecordName(row.data) };
  }
  return null;
}

// Auto-creates a minimal contact for a brand-new caller once a call ends,
// using whatever name they gave during the call (see
// db.findCapturedNameForCall) — without this, a repeat caller who was
// never manually added to Contact Directory stays a disconnected phone
// number forever, even after calling multiple times. Maps onto whichever
// of this org's primary object's actual field keys are name-typed
// (required text, or first text field) and phone-typed, since those vary
// per industry pack.
async function createContactFromCall(orgId, name, phone) {
  requireDb();
  const objects = await listObjects(orgId);
  if (!objects.length) return null;
  const primary = objects[0];
  const nameField = primary.fields.find((f) => f.type === "text" && f.required) || primary.fields.find((f) => f.type === "text");
  const phoneField = primary.fields.find((f) => f.type === "phone") || primary.fields.find((f) => f.key === "phone");
  if (!nameField) return null;

  const normalizedPhone = phone ? normalizePhone(phone) : null;
  if (normalizedPhone) {
    const existing = await findRecordByPhone(orgId, normalizedPhone);
    if (existing) return existing;
  }

  const data = { [nameField.key]: name };
  if (phoneField && normalizedPhone) data[phoneField.key] = normalizedPhone;
  return createRecord(orgId, primary.key, data);
}

async function createRecord(orgId, objectKey, body) {
  const object = await getObjectByKey(orgId, objectKey);
  if (!object) {
    const err = new Error(`Object "${objectKey}" not found`);
    err.statusCode = 404;
    throw err;
  }
  const { stageKey, ...data } = body;

  // Phone is a canonical identity field. When a phone field exists but the
  // user leaves it empty, keep the configured country prefix as the editable
  // starting value. A bare prefix is never considered a complete phone for
  // contact matching/deduplication.
  for (const field of object.fields) {
    if (field.type !== "phone") continue;
    data[field.key] = normalizePhoneInput(data[field.key]);
  }

  validateAgainstFields(object.fields, data);

  let stageId = null;
  if (stageKey) {
    const stage = object.stages.find((s) => s.key === stageKey);
    stageId = stage ? stage.id : null;
  } else if (object.stages.length) {
    stageId = object.stages[0].id; // default to first stage
  }

  const { data: row, error } = await db.supabase
    .from("object_records")
    .insert({ org_id: orgId, object_id: object.id, stage_id: stageId, data })
    .select()
    .single();
  if (error) throw new Error(`[objectsEngine.createRecord] ${error.message}`);
  return recordRowToApi(row);
}

async function patchRecord(orgId, objectKey, recordId, body) {
  const object = await getObjectByKey(orgId, objectKey);
  if (!object) {
    const err = new Error(`Object "${objectKey}" not found`);
    err.statusCode = 404;
    throw err;
  }
  const { stageKey, ...patch } = body;

  // Apply the same canonical phone representation on updates.
  for (const field of object.fields) {
    if (field.type === "phone" && patch[field.key]) {
      patch[field.key] = normalizePhone(patch[field.key]);
    }
  }

  const { data: existing, error: getErr } = await db.supabase
    .from("object_records")
    .select("data")
    .eq("id", recordId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (getErr) throw new Error(`[objectsEngine.patchRecord] ${getErr.message}`);
  if (!existing) return null;

  const mergedData = { ...existing.data, ...patch };

  const updatePayload = { data: mergedData, updated_at: new Date().toISOString() };
  if (stageKey) {
    const stage = object.stages.find((s) => s.key === stageKey);
    if (stage) updatePayload.stage_id = stage.id;
  }

  const { data: row, error } = await db.supabase
    .from("object_records")
    .update(updatePayload)
    .eq("id", recordId)
    .eq("org_id", orgId)
    .select()
    .single();
  if (error) throw new Error(`[objectsEngine.patchRecord] ${error.message}`);
  return recordRowToApi(row);
}

async function removeRecord(orgId, objectKey, recordId) {
  requireDb();
  const { error } = await db.supabase.from("object_records").delete().eq("id", recordId).eq("org_id", orgId);
  if (error) throw new Error(`[objectsEngine.removeRecord] ${error.message}`);
  return true;
}

// ------------------------------------------------------------
// Dashboard metrics — the generic-industry equivalent of the
// lending-specific loan/lead aggregates in server.js's
// /api/dashboard/metrics. Used for any org whose industry isn't
// "lending" (no loans/leads data to aggregate instead).
// ------------------------------------------------------------

async function getDashboardMetrics(orgId) {
  if (!db.supabase) return [];
  const objects = await listObjects(orgId);
  if (!objects.length) return [];

  const objectIds = objects.map((o) => o.id);
  const { data: records, error } = await db.supabase
    .from("object_records")
    .select("*")
    .in("object_id", objectIds);
  if (error) throw new Error(`[objectsEngine.getDashboardMetrics] ${error.message}`);

  const monthKeys = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  return objects.map((object) => {
    const objectRecords = (records || []).filter((r) => r.object_id === object.id);

    const stageCounts = {};
    for (const stage of object.stages) stageCounts[stage.id] = 0;
    for (const record of objectRecords) {
      if (record.stage_id && stageCounts[record.stage_id] !== undefined) stageCounts[record.stage_id]++;
    }
    const stageDistribution = object.stages.map((stage) => ({
      stage: stage.label,
      count: stageCounts[stage.id] || 0
    }));

    const monthCounts = {};
    for (const key of monthKeys) monthCounts[key] = 0;
    for (const record of objectRecords) {
      if (!record.created_at) continue;
      const d = new Date(record.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (monthCounts[key] !== undefined) monthCounts[key]++;
    }
    const recordsTrend = monthKeys.map((month) => ({ month, count: monthCounts[month] }));

    return {
      objectKey: object.key,
      objectLabel: object.label,
      totalRecords: objectRecords.length,
      stageDistribution,
      recordsTrend
    };
  });
}

module.exports = {
  listObjects,
  getObjectByKey,
  createObject,
  listRecords,
  findRecordByPhone,
  createContactFromCall,
  createRecord,
  patchRecord,
  removeRecord,
  getDashboardMetrics
};
