// ============================================================
// services/db.js
//
// Org-scoped data access layer for the CRM entities.
//
// DATA lives entirely in a self-hosted MySQL database (MYSQL_URL),
// via the MySQL adapter, which preserves the existing chainable query-builder
// and auth-compatible surface so the application data-access modules remain
// stable during the database migration.
//
// Call recordings use the configured object-storage provider and are handled
// separately from the relational database layer.
//
// API objects use the same camelCase shape as frontend/src/types.ts;
// this module translates to/from snake_case MySQL columns.
// ============================================================

const supabase = require("./client");
const industryPacks = require("../seed/industryPacks");
const {
  SCHEDULE_STATUS_RANK,
  pendingScheduleRowsConflict,
  dedupePendingScheduleRows,
} = require("../crm/postCallScheduleDedupe");
const { getLogger } = require("../observability/logger");
const organizationRepository = require("./repositories/organizationRepository");
const aiUsageRepository = require("./repositories/aiUsageRepository");
const log = getLogger("db.repository");

// Shared pool for all repository queries and transactions.
const { pool: _pool, closePool } = require("./pool");

function isConfigured() {
  return true; // the MySQL pool is configured via MYSQL_URL at require time
}

// ------------------------------------------------------------
// Entity field maps: apiKey -> db column
// ------------------------------------------------------------

const ENTITIES = {
  leads: {
    table: "leads",
    fields: {
      id: "id", name: "name", phone: "phone", email: "email", gender: "gender",
      amountRequested: "amount_requested", score: "score", source: "source",
      status: "status", tags: "tags", notes: "notes",
      financialInfo: "financial_info", groupIds: "group_ids",
      pipelineStage: "pipeline_stage",
      createdAt: "created_at", updatedAt: "updated_at"
    }
  },
  contactgroups: {
    table: "contact_groups",
    fields: {
      id: "id", name: "name", createdAt: "created_at"
    }
  },
  workflows: {
    table: "workflows",
    fields: {
      id: "id", name: "name", active: "active", nodes: "nodes", edges: "edges",
      createdAt: "created_at", updatedAt: "updated_at"
    }
  },
  questionflows: {
    table: "question_flows",
    fields: {
      id: "id", name: "name", description: "description",
      variables: "variables", active: "active",
      createdAt: "created_at", updatedAt: "updated_at"
    }
  },
  campaigns: {
    table: "campaigns",
    fields: {
      id: "id", name: "name", status: "status", workflowId: "workflow_id",
      totalLeads: "total_leads", calledLeads: "called_leads",
      successfulCalls: "successful_calls", createdAt: "created_at", updatedAt: "updated_at"
    }
  },
  loans: {
    table: "loans",
    fields: {
      id: "id", leadId: "lead_id", leadName: "lead_name", amount: "amount",
      interestRate: "interest_rate", termMonths: "term_months", status: "status",
      monthlyEmi: "monthly_emi", paidEmiCount: "paid_emi_count",
      totalEmiCount: "total_emi_count", nextPaymentDate: "next_payment_date",
      documents: "documents", history: "history",
      createdAt: "created_at", updatedAt: "updated_at"
    }
  },
  calllogs: {
    table: "call_logs",
    fields: {
      id: "id", leadId: "lead_id", leadName: "lead_name", callerNumber: "caller_number",
      campaignId: "campaign_id",
      duration: "duration", status: "status", sentiment: "sentiment", intent: "intent",
      transcript: "transcript", summary: "summary", recordingUrl: "recording_url",
      direction: "direction", createdAt: "created_at",
      attemptNumber: "attempt_number", nextRetryAt: "next_retry_at", retryStatus: "retry_status",
      retryContext: "retry_context",
      retryClaimedAt: "retry_claimed_at",
      // The originating telephony provider's own call id (Vobiz CallUUID /
      // Twilio CallSid / Piopiy call id) — set by callFinalizer.js. Lets a
      // background process (autoDialEngine.js) recognize "this specific
      // outbound call it placed has finished" without needing an
      // in-process event of its own; it just polls for a call_logs row
      // with this value.
      providerCallSid: "provider_call_sid",
      // Set when a call ends with the caller asking to be called back
      // later ("I'm busy, call me after 6pm") — see callFinalizer.js and
      // src/ai/postCallAgents.js:extractFollowUp. status is "Callback
      // Scheduled" (not "Completed") for such calls, and this holds the
      // best-effort ISO datetime the follow-up extractor resolved, or
      // null if the caller was too vague to pin down an actual time.
      callbackTime: "callback_time",
      // True only when the callee actually engaged (said something beyond
      // a couple of words) — distinct from status: a call can be
      // "Completed" (someone picked up, wasn't a machine, didn't
      // explicitly ask for a callback) while callAnswered is still false,
      // e.g. they picked up, said nothing or "wrong number", and hung up.
      // See callFinalizer.js's callerWordCount heuristic.
      callAnswered: "call_answered",
      // One-line reason for a "Callback Scheduled" call — see
      // callFinalizer.js's followUp.querySummary.
      callbackReason: "callback_reason",
      conversationOutcome: "conversation_outcome",
      callbackStatus: "callback_status",
      enquiryStatus: "enquiry_status"
    }
  },
  dialertasks: {
    table: "dialer_tasks",
    fields: {
      id: "id", name: "name", questions: "questions", leadIds: "lead_ids",
      status: "status", callResults: "call_results", starhealthEnabled: "starhealth_enabled",
      createdAt: "created_at", updatedAt: "updated_at",
      // Config the frontend already sends per-call to /api/vobiz/call but
      // which previously had nowhere to persist on the task itself — a
      // server-driven auto-dial loop has no per-request body to read these
      // from, so they need to live on the row.
      language: "language", assignedTeamMemberId: "assigned_team_member_id",
      // Server-owned auto-dial runtime state (see src/crm/autoDialEngine.js).
      // Deliberately preserved across POST /dialer-tasks/sync's delete+
      // reinsert — see replaceDialerTasks below — since the frontend's
      // local task objects don't carry these fields and would otherwise
      // silently wipe them out on every periodic sync.
      autoDialEnabled: "auto_dial_enabled", autoDialStatus: "auto_dial_status",
      currentLeadId: "current_lead_id", currentProviderCallSid: "current_provider_call_sid",
      currentCallStartedAt: "current_call_started_at", currentProvider: "current_provider",
      nextDialAt: "next_dial_at", autoDialStartedAt: "auto_dial_started_at",
      // Which outbound number/provider to dial through — set once, at
      // auto-dial start time, from whatever the frontend had selected in
      // the Voice Simulator at that moment. A server-driven dial has no
      // per-request "selected number" the way a frontend-initiated call
      // does, so this is the one place it has to live.
      outboundNumber: "outbound_number",
      retryConfig: "retry_config",
      // See mysql.js's dialer_tasks.workflow_id column comment — was
      // never persisted at all before, only living in frontend memory.
      workflowId: "workflow_id",
      workflowRunMetadata: "workflow_run_metadata"
    }
  },
  inboundcalllogs: {
    table: "inbound_call_logs",
    fields: {
      id: "id", callerName: "caller_name", callerPhone: "caller_phone",
      virtualNumber: "virtual_number", duration: "duration", status: "status",
      sentiment: "sentiment", intent: "intent", topic: "topic",
      transcript: "transcript", summary: "summary", createdAt: "created_at"
    }
  },
  numbers: {
    table: "virtual_numbers",
    fields: {
      id: "id", number: "number", provider: "provider", status: "status",
      friendlyName: "friendly_name", routingUrl: "routing_url",
      incomingCallCount: "incoming_call_count", outgoingCallCount: "outgoing_call_count",
      agentId: "agent_id",
      createdAt: "created_at"
    }
  },
  team: {
    table: "org_members",
    fields: {
      id: "id", name: "name", email: "email", phone: "phone", role: "role", status: "status",
      performanceScore: "performance_score", assignedLeadsCount: "assigned_leads_count",
      featureFlags: "feature_flags",
      createdAt: "created_at"
    }
  },
  customers: {
    table: "customers",
    fields: {
      id: "id", name: "name", phone: "phone", type: "type", locality: "locality",
      ltv: "ltv", khata: "khata", createdAt: "created_at"
    }
  },
  catalog: {
    table: "catalog_items",
    fields: {
      id: "id", name: "name", brand: "brand", unit: "unit", price: "price",
      stock: "stock", createdAt: "created_at"
    }
  },
  orders: {
    table: "orders",
    fields: {
      id: "id", customer: "customer", phone: "phone", items: "items", total: "total",
      status: "status", source: "source", time: "time", delivery: "delivery",
      createdAt: "created_at"
    }
  },
  leadresponses: {
    table: "lead_responses",
    fields: {
      id: "id", callId: "call_id", policyholderPhone: "policyholder_phone",
      question: "question", answer: "answer", label: "label", createdAt: "created_at"
    }
  },
  enquiries: {
    table: "enquiries",
    fields: {
      id: "id", callId: "call_id", name: "name", phone: "phone", email: "email",
      location: "location", queryText: "query_text",
      assignedTeamMemberId: "assigned_team_member_id", status: "status",
      createdAt: "created_at"
    }
  },
  // Gemini Live per-session usage/cost tracking — see
  // src/ai/geminiUsageTracker.js and docs/ai-usage-tracking.md.
  aisessionusage: {
    table: "ai_session_usage",
    fields: {
      id: "id", orgId: "org_id", adminId: "admin_id", callId: "call_id", sessionId: "session_id",
      provider: "provider", gcpProjectId: "gcp_project_id", gcpLocation: "gcp_location", model: "model",
      sessionStartedAt: "session_started_at", sessionEndedAt: "session_ended_at", durationSeconds: "duration_seconds",
      inputTokens: "input_tokens", outputTokens: "output_tokens", totalTokens: "total_tokens",
      inputCost: "input_cost", outputCost: "output_cost", totalCost: "total_cost",
      currency: "currency", pricingVersion: "pricing_version",
      status: "status", errorCode: "error_code", errorMessage: "error_message", metadata: "metadata",
      actualBilledCost: "actual_billed_cost", billingExportId: "billing_export_id", billingPeriod: "billing_period",
      reconciliationStatus: "reconciliation_status", reconciledAt: "reconciled_at",
      // Platform-rate (INR) cost, locked in at finalize time — see
      // ai/geminiUsageTracker.js and migrations/add_ai_session_usage_platform_cost.sql.
      platformCostProviderKey: "platform_cost_provider_key", platformPricingMode: "platform_pricing_mode", platformRatePer1k: "platform_rate_per_1k",
      platformTokenUnit: "platform_token_unit", platformTimeRateAmount: "platform_time_rate_amount", platformTimeUnit: "platform_time_unit",
      platformTaxPercent: "platform_tax_percent", platformBaseCostInr: "platform_base_cost_inr",
      platformTaxAmountInr: "platform_tax_amount_inr", platformTotalCostInr: "platform_total_cost_inr",
      createdAt: "created_at", updatedAt: "updated_at"
    }
  }
};

function toDbRow(entity, apiObj) {
  const map = ENTITIES[entity].fields;
  const row = {};
  for (const [apiKey, dbKey] of Object.entries(map)) {
    if (apiObj[apiKey] !== undefined) row[dbKey] = apiObj[apiKey];
  }
  return row;
}

function fromDbRow(entity, row) {
  if (!row) return row;
  const map = ENTITIES[entity].fields;
  const obj = {};
  for (const [apiKey, dbKey] of Object.entries(map)) {
    if (row[dbKey] !== undefined) obj[apiKey] = row[dbKey];
  }
  return obj;
}

function assertEntity(entity) {
  if (!ENTITIES[entity]) throw new Error(`[db.js] unknown entity "${entity}"`);
}

// ------------------------------------------------------------
// Generic CRUD, scoped by orgId
// ------------------------------------------------------------

// `options` is opt-in and backward compatible: every existing call site
// passes only (entity, orgId) and keeps getting the full array back,
// unchanged. Pass { page, limit } to page server-side instead — the
// response shape changes to { rows, total } only in that case, so
// callers must explicitly ask for pagination to get it.
async function list(entity, orgId, options = {}) {
  assertEntity(entity);
  const { table, fields } = ENTITIES[entity];
  const { page, limit, callId } = options;
  const paginate = Number.isInteger(page) && Number.isInteger(limit) && page > 0 && limit > 0;

  let query = supabase
    .from(table)
    .select("*", paginate ? { count: "exact" } : undefined)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (callId && fields.callId) {
    query = query.eq(fields.callId, callId);
  }

  if (paginate) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    query = query.range(from, to);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`[db.list:${entity}] ${error.message}`);
  const rows = (data || []).map((row) => fromDbRow(entity, row));
  return paginate ? { rows, total: count ?? rows.length } : rows;
}

async function create(entity, orgId, apiObj) {
  assertEntity(entity);
  const { table } = ENTITIES[entity];
  const row = { ...toDbRow(entity, apiObj), org_id: orgId };
  if (!apiObj.id) delete row.id; // let MySQL generate the uuid
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`[db.create:${entity}] ${error.message}`);
  return fromDbRow(entity, data);
}

async function patch(entity, orgId, id, apiPatch) {
  assertEntity(entity);
  const { table } = ENTITIES[entity];
  const row = toDbRow(entity, apiPatch);
  const { data, error } = await supabase
    .from(table)
    .update(row)
    .eq("id", id)
    .eq("org_id", orgId)
    .select()
    .single();
  if (error) throw new Error(`[db.patch:${entity}] ${error.message}`);
  return fromDbRow(entity, data);
}

async function remove(entity, orgId, id) {
  assertEntity(entity);
  const { table } = ENTITIES[entity];
  const { error } = await supabase.from(table).delete().eq("id", id).eq("org_id", orgId);
  if (error) throw new Error(`[db.remove:${entity}] ${error.message}`);
  return true;
}

// ------------------------------------------------------------
// Transaction helper: DELETE all rows for orgId, then INSERT
// replacements — all in a single BEGIN/COMMIT so a failed INSERT
// cannot leave the table empty.
// ------------------------------------------------------------

async function _txReplaceRows(table, orgId, rows, deserialize, tag) {
  const tableDef = supabase.TABLES && supabase.TABLES[table];
  const client = await _pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
    const result = [];
    for (const apiRow of rows) {
      const row = { ...apiRow };
      if (!row.id) row.id = require("crypto").randomUUID();
      if (!row.created_at) row.created_at = new Date().toISOString();
      // Determine column list — use the known table def if available, else all keys
      const cols = tableDef
        ? Object.keys(row).filter((c) => c in tableDef.columns)
        : Object.keys(row);
      const placeholders = cols.map((c, idx) => {
        if (!tableDef) return `$${idx + 1}`;
        const t = tableDef.columns[c];
        const sqlT = t === "int" ? "INTEGER" : t === "bool" ? "BOOLEAN" : t === "real" ? "DOUBLE PRECISION" : t === "json" ? "JSON" : t === "array" ? "JSON" : "TEXT";
        return `$${idx + 1}`;
      }).join(", ");
      const values = cols.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return null;
        if (tableDef && (tableDef.columns[c] === "json")) return JSON.stringify(v);
        return v;
      });
      await client.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
        values
      );
      const { rows: saved } = await client.query(`SELECT * FROM ${table} WHERE id = $1`, [row.id]);
      result.push(deserialize(saved[0]));
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw new Error(`${tag} transaction failed: ${err.message}`);
  } finally {
    client.release();
  }
}

// Bulk overwrite — used by the legacy /api/*/sync endpoints that push the
// frontend's full local copy back to the backend.
async function replaceAll(entity, orgId, apiArray) {
  assertEntity(entity);
  // "team" (org_members) carries a server-only field — user_id, the link
  // to a real application auth account — that the frontend's TeamMember type
  // doesn't know about and can never round-trip. A plain delete+reinsert
  // here would silently null out that link for every member on every
  // sync, locking real accounts out ("not a member of any organization").
  // See replaceTeamMembers, which preserves it.
  if (entity === "team") return replaceTeamMembers(orgId, apiArray);
  // "dialertasks" carries server-owned auto-dial runtime state (see the
  // autoDialEnabled/autoDialStatus/current*/nextDialAt fields above) that
  // the frontend's local task objects don't know about — a plain
  // delete+reinsert here would silently reset an in-progress background
  // auto-dial to "idle" on the task's own next periodic sync. See
  // replaceDialerTasks, which preserves it.
  if (entity === "dialertasks") return replaceDialerTasks(orgId, apiArray);
  // "numbers" (virtual_numbers) is the FK target of
  // org_agents.outbound_number_id (ON DELETE SET NULL). The frontend syncs
  // this entity on every edit via a debounced POST, roughly once a minute
  // in practice — _txReplaceRows's delete-then-reinsert would DELETE every
  // row for the org on every one of those syncs before reinserting it
  // (even with the same id moments later), which fires the FK cascade and
  // silently nulls out every agent's assigned outbound number every time
  // the sync runs. See replaceNumbers, which upserts in place instead so a
  // number that's still present in the synced list is never deleted at all.
  if (entity === "numbers") return replaceNumbers(orgId, apiArray);
  // "leads" (contacts) hits this path on every add/edit from the frontend
  // (App.tsx's leads useEffect POSTs the ENTIRE local `leads` array to
  // /api/leads/sync whenever any one lead changes) — same shape of bug as
  // "numbers" above, but worse: _txReplaceRows's blanket DELETE FROM leads
  // WHERE org_id = $1 doesn't just risk an FK cascade, it means a lead
  // that exists in the database but isn't in THIS browser tab's local
  // state (created moments earlier by another tab/session, by an inbound
  // call auto-registering a new caller, or by a CSV import) gets silently
  // deleted the next time this tab syncs anything at all. See
  // replaceLeads, which never deletes — only inserts/updates rows that
  // are actually present in the incoming array. Real deletions still go
  // through the dedicated DELETE /api/leads/:id route.
  if (entity === "leads") return replaceLeads(orgId, apiArray);

  const { table } = ENTITIES[entity];
  // An empty payload here is indistinguishable from "the frontend's local
  // state got wiped by a transient failure" (a failed GET during load
  // falling back to [], a dropped session, a race on refresh) — this used
  // to delete-then-return-early, so a single bad sync call permanently
  // erased every real row for the org. None of the sync call sites ever
  // legitimately need to clear an entity to zero (deletes go through
  // db.remove for a specific id), so treat an empty array as a no-op
  // instead of a wipe.
  if (!apiArray || !apiArray.length) {
    const { data: existing } = await supabase.from(table).select("id").eq("org_id", orgId).limit(1);
    if (existing && existing.length > 0) {
      log.warn(`⚠️ [db.replaceAll:${entity}] received an empty sync payload for org ${orgId} with existing rows — ignoring instead of wiping.`);
    }
    return [];
  }
  const rows = apiArray.map((o) => ({ ...toDbRow(entity, o), org_id: orgId }));
  return _txReplaceRows(table, orgId, rows, (row) => fromDbRow(entity, row), `[db.replaceAll:${entity}]`);
}

async function replaceTeamMembers(orgId, apiArray) {
  const { data: existing, error: existingErr } = await supabase
    .from("org_members")
    .select("id, user_id, email, feature_flags")
    .eq("org_id", orgId);
  if (existingErr) throw new Error(`[db.replaceTeamMembers] read existing: ${existingErr.message}`);

  const userIdById = new Map((existing || []).filter((r) => r.user_id).map((r) => [r.id, r.user_id]));
  const userIdByEmail = new Map((existing || []).filter((r) => r.user_id && r.email).map((r) => [r.email.toLowerCase(), r.user_id]));
  // Preserve feature_flags that were set via the dedicated /team POST — the frontend
  // TeamMember type doesn't carry featureFlags so the sync payload won't include them.
  const featureFlagsById = new Map((existing || []).map((r) => [r.id, r.feature_flags || []]));
  const featureFlagsByEmail = new Map((existing || []).filter((r) => r.email).map((r) => [r.email.toLowerCase(), r.feature_flags || []]));

  // Same empty-payload guard as replaceAll — an empty sync here would
  // otherwise delete every team member (including the account's own
  // org_members row) on a transient frontend failure.
  if (!apiArray || !apiArray.length) {
    if (existing && existing.length > 0) {
      log.warn(`⚠️ [db.replaceTeamMembers] received an empty sync payload for org ${orgId} with existing rows — ignoring instead of wiping.`);
    }
    return [];
  }

  const rows = apiArray.map((o) => {
    const row = { ...toDbRow("team", o), org_id: orgId };
    const preservedUserId = userIdById.get(o.id) || userIdByEmail.get((o.email || "").toLowerCase()) || null;
    if (preservedUserId) row.user_id = preservedUserId;
    // Always preserve feature_flags from DB — never let the sync overwrite them with null.
    const preservedFlags = featureFlagsById.get(o.id) || featureFlagsByEmail.get((o.email || "").toLowerCase()) || row.feature_flags || [];
    row.feature_flags = preservedFlags;
    return row;
  });
  return _txReplaceRows("org_members", orgId, rows, (row) => fromDbRow("team", row), "[db.replaceTeamMembers]");
}

const AUTO_DIAL_RUNTIME_COLUMNS = [
  "auto_dial_enabled", "auto_dial_status", "current_lead_id", "current_provider_call_sid",
  "current_call_started_at", "current_provider", "next_dial_at", "auto_dial_started_at",
  "outbound_number"
];

async function replaceDialerTasks(orgId, apiArray) {
  const { data: existing, error: existingErr } = await supabase
    .from("dialer_tasks")
    .select(`id, ${AUTO_DIAL_RUNTIME_COLUMNS.join(", ")}`)
    .eq("org_id", orgId);
  if (existingErr) throw new Error(`[db.replaceDialerTasks] read existing: ${existingErr.message}`);
  const runtimeById = new Map((existing || []).map((r) => [r.id, r]));

  // Same empty-payload guard as replaceAll/replaceTeamMembers — an empty
  // sync here would otherwise delete every dialer task (including one
  // mid-auto-dial) on a transient frontend failure.
  if (!apiArray || !apiArray.length) {
    if (existing && existing.length > 0) {
      log.warn(`⚠️ [db.replaceDialerTasks] received an empty sync payload for org ${orgId} with existing rows — ignoring instead of wiping.`);
    }
    return [];
  }

  const rows = apiArray.map((o) => {
    const row = { ...toDbRow("dialertasks", o), org_id: orgId };
    const preserved = runtimeById.get(o.id);
    if (preserved) {
      for (const col of AUTO_DIAL_RUNTIME_COLUMNS) row[col] = preserved[col];
    }
    return row;
  });
  const result = await _txReplaceRows("dialer_tasks", orgId, rows, (row) => fromDbRow("dialertasks", row), "[db.replaceDialerTasks]");

  // Advance contact->campaign the moment a contact is first added to any
  // dialer task's lead list — the automatic half of the universal
  // pipeline-stage progression (see mysql.js's leads.pipeline_stage
  // comment; the other automatic step is callFinalizer.js's ->lead on an
  // actually-answered call). Best-effort: a failure here shouldn't fail
  // the task save itself, since the task row is already committed above.
  const allLeadIds = [...new Set(apiArray.flatMap((t) => t.leadIds || []))];
  if (allLeadIds.length) {
    try {
      await _pool.query(
        `UPDATE leads SET pipeline_stage = 'campaign'
         WHERE org_id = $1 AND id IN (${allLeadIds.map(() => "?").join(",")}) AND (pipeline_stage IS NULL OR pipeline_stage = 'contact')`,
        [orgId, ...allLeadIds]
      );
    } catch (err) {
      log.error(`❌ [db.replaceDialerTasks] failed to advance pipeline_stage for org ${orgId}:`, err.message);
    }
  }

  return result;
}

// Upsert-in-place variant of _txReplaceRows: updates rows that still exist
// (matched by id, falling back to the "number" phone string so a row the
// frontend never got an id for — or lost round-tripping it — still matches
// its existing DB row instead of being deleted and recreated with a new
// id), inserts genuinely new rows, and deletes only rows that are truly no
// longer present in the incoming sync. Unlike _txReplaceRows, a row that's
// merely being updated is never deleted, so any foreign key pointing at it
// (org_agents.outbound_number_id -> virtual_numbers.id, ON DELETE SET
// NULL) never fires for it.
async function replaceNumbers(orgId, apiArray) {
  const { data: existing, error: existingErr } = await supabase
    .from("virtual_numbers")
    .select("id, number")
    .eq("org_id", orgId);
  if (existingErr) throw new Error(`[db.replaceNumbers] read existing: ${existingErr.message}`);

  // Same empty-payload guard as replaceAll/replaceTeamMembers/replaceDialerTasks.
  if (!apiArray || !apiArray.length) {
    if (existing && existing.length > 0) {
      log.warn(`⚠️ [db.replaceNumbers] received an empty sync payload for org ${orgId} with existing rows — ignoring instead of wiping.`);
    }
    return [];
  }

  const existingById = new Map((existing || []).map((r) => [r.id, r]));
  const existingByNumber = new Map((existing || []).map((r) => [r.number, r]));

  const rows = apiArray.map((o) => {
    const row = { ...toDbRow("numbers", o), org_id: orgId };
    const matched = (row.id && existingById.get(row.id)) || existingByNumber.get(row.number);
    // Reuse the existing row's real id whenever we matched by phone number
    // instead of id — this is what lets the FK target survive: the same
    // virtual_numbers.id gets UPDATEd, never dropped and recreated.
    if (matched) row.id = matched.id;
    return row;
  });

  // A Vobiz number also owns a channel row. If a number disappears from the
  // synced virtual-number list (or is changed to a different number), remove
  // its stale Vobiz channel too; channels.type + external_id is globally
  // unique, so leaving it behind prevents the number from being connected
  // again after removal.
  const incomingNumbers = new Set(
    rows.map((r) => String(r.number || "").trim()).filter(Boolean)
  );
  const removedNumbers = (existing || [])
    .map((r) => String(r.number || "").trim())
    .filter((number) => number && !incomingNumbers.has(number));

  const keepIds = rows.map((r) => r.id).filter(Boolean);
  const table = "virtual_numbers";
  const tableDef = supabase.TABLES && supabase.TABLES[table];
  const client = await _pool.connect();
  try {
    await client.query("BEGIN");
    // Only delete numbers the org actually removed from its list — not the
    // ones being updated (those are UPSERTed below without ever being
    // deleted, so the outbound_number_id FK pointing at them never cascades).
    if (keepIds.length) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1 AND id NOT IN (${keepIds.map(() => "?").join(",")})`, [orgId, ...keepIds]);
    } else {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
    }

    if (removedNumbers.length) {
      await client.query(
        `DELETE FROM channels
         WHERE org_id = ? AND type = "vobiz"
           AND external_id IN (${removedNumbers.map(() => "?").join(",")})`,
        [orgId, ...removedNumbers]
      );
    }

    const result = [];
    for (const apiRow of rows) {
      const row = { ...apiRow };
      if (!row.id) row.id = require("crypto").randomUUID();
      if (!row.created_at) row.created_at = new Date().toISOString();
      const cols = tableDef ? Object.keys(row).filter((c) => c in tableDef.columns) : Object.keys(row);
      const placeholders = cols.map((c, idx) => {
        if (!tableDef) return `$${idx + 1}`;
        const t = tableDef.columns[c];
        const sqlT = t === "int" ? "INTEGER" : t === "bool" ? "BOOLEAN" : t === "real" ? "DOUBLE PRECISION" : t === "json" ? "JSON" : t === "array" ? "JSON" : "TEXT";
        return `$${idx + 1}`;
      }).join(", ");
      const values = cols.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return null;
        if (tableDef && tableDef.columns[c] === "json") return JSON.stringify(v);
        return v;
      });
      const updateSet = cols.filter((c) => c !== "id").map((c) => `${c} = VALUES(${c})`).join(", ");
      await client.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updateSet}`,
        values
      );
      const { rows: saved } = await client.query(`SELECT * FROM ${table} WHERE id = $1`, [row.id]);
      result.push(fromDbRow("numbers", saved[0]));
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw new Error(`[db.replaceNumbers] transaction failed: ${err.message}`);
  } finally {
    client.release();
  }
}

// Upsert-only sync for "leads" — inserts/updates whatever rows are in
// apiArray, matched by id (or by phone number as a fallback for a
// client-generated "L-<n>" id that hasn't round-tripped a real id yet,
// same reasoning as replaceNumbers matching by phone number). Deliberately
// never deletes anything, unlike _txReplaceRows/replaceNumbers — the
// incoming array here is just "whatever this browser tab currently has in
// memory", not an authoritative full list, so treating it as one and
// deleting whatever's missing from it would delete real leads the tab
// simply hasn't loaded yet. Real deletions go through db.remove via the
// dedicated DELETE /api/leads/:id route instead.
async function replaceLeads(orgId, apiArray) {
  const { table } = ENTITIES.leads;
  if (!apiArray || !apiArray.length) return [];

  const { data: existing, error: existingErr } = await supabase
    .from(table)
    .select("id, phone, pipeline_stage")
    .eq("org_id", orgId);
  if (existingErr) throw new Error(`[db.replaceLeads] read existing: ${existingErr.message}`);
  const existingById = new Map((existing || []).map((r) => [r.id, r]));
  const existingByPhone = new Map((existing || []).filter((r) => r.phone).map((r) => [r.phone, r]));

  // `leads.id` is a single global primary key, not scoped per org — the
  // frontend used to generate new-contact ids deterministically
  // (`L-${100 + leads.length + 1}`), so the FIRST contact created in any
  // two different orgs both got id "L-101", tripping
  // "duplicate key value violates unique constraint leads_pkey" (confirmed
  // live). The frontend now generates collision-resistant ids, but this is
  // the actual multi-tenant safety net: without it, an ON CONFLICT (id) DO
  // UPDATE below would silently reassign another org's real contact row to
  // this org the moment two orgs ever did collide on an id. Ids present in
  // the incoming array that belong to a DIFFERENT org get a fresh id
  // instead of being allowed to touch that row.
  const candidateIds = apiArray.map((o) => o.id).filter(Boolean);
  let idOwner = new Map();
  if (candidateIds.length) {
    const { data: owners, error: ownersErr } = await supabase
      .from(table)
      .select("id, org_id")
      .in("id", candidateIds);
    if (ownersErr) throw new Error(`[db.replaceLeads] read id owners: ${ownersErr.message}`);
    idOwner = new Map((owners || []).map((r) => [r.id, r.org_id]));
  }

  const tableDef = supabase.TABLES && supabase.TABLES[table];
  const client = await _pool.connect();
  try {
    await client.query("BEGIN");
    const result = [];
    for (const apiRow of apiArray) {
      const row = { ...toDbRow("leads", apiRow), org_id: orgId };
      const matched = (row.id && existingById.get(row.id)) || (row.phone && existingByPhone.get(row.phone));
      if (matched) row.id = matched.id;
      else if (row.id && idOwner.has(row.id) && idOwner.get(row.id) !== orgId) row.id = require("crypto").randomUUID();
      if (!row.id) row.id = require("crypto").randomUUID();
      if (!row.created_at) row.created_at = new Date().toISOString();

      // Advance the universal contact->campaign->lead->opportunity->client
      // pipeline stage when a human qualification decision comes through
      // (status set to Qualified/Converted) — the two stages with no
      // automatic signal of their own (contact->campaign and ->lead ARE
      // automatic, see replaceDialerTasks/callFinalizer.js). Deliberately
      // NOT set for any other status value, so the upsert below leaves
      // whatever stage is already stored untouched (pipeline_stage is only
      // included in the column list — and therefore only written — when
      // explicitly assigned here).
      const currentStage = matched?.pipeline_stage;
      if (row.status === "Qualified" && currentStage !== "client") row.pipeline_stage = "opportunity";
      else if (row.status === "Converted") row.pipeline_stage = "client";

      const cols = tableDef ? Object.keys(row).filter((c) => c in tableDef.columns) : Object.keys(row);
      const placeholders = cols.map((c, idx) => {
        if (!tableDef) return `$${idx + 1}`;
        const t = tableDef.columns[c];
        const sqlT = t === "int" ? "INTEGER" : t === "bool" ? "BOOLEAN" : t === "real" ? "DOUBLE PRECISION" : t === "json" ? "JSON" : t === "array" ? "JSON" : "TEXT";
        return `$${idx + 1}`;
      }).join(", ");
      const values = cols.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return null;
        if (tableDef && tableDef.columns[c] === "json") return JSON.stringify(v);
        return v;
      });
      const updateSet = cols.filter((c) => c !== "id").map((c) => `${c} = VALUES(${c})`).join(", ");
      await client.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updateSet}`,
        values
      );
      const { rows: saved } = await client.query(`SELECT * FROM ${table} WHERE id = $1`, [row.id]);
      result.push(fromDbRow("leads", saved[0]));
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw new Error(`[db.replaceLeads] transaction failed: ${err.message}`);
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// Organizations (single row per org; core columns + free-form
// jsonb "settings" for industry-specific/extra fields so any
// vertical can add fields without a migration)
// ------------------------------------------------------------

// Organization persistence is delegated to the dedicated repository boundary.
// Keep these legacy method names as compatibility facades so existing routes
// and engines do not need a risky all-at-once refactor.
const ORG_CORE_FIELDS = organizationRepository.CORE_FIELDS || {};
const orgRowToApi = organizationRepository.toApi;

async function createOrg(args) { return organizationRepository.create(args); }
async function createOrganizationSetup(args) { return organizationRepository.createOrganizationSetup(args); }
async function getOrg(orgId) { return organizationRepository.get(orgId); }
async function updateOrg(orgId, apiPatch) { return organizationRepository.update(orgId, apiPatch); }
async function createOrgCloudProject(args) { return organizationRepository.createCloudProjectRecord(args); }
async function getOrgCloudProject(orgId) { return organizationRepository.getCloudProject(orgId); }
async function getOrgCloudProjectWithCredentials(orgId) { return organizationRepository.getCloudProjectWithCredentials(orgId); }
async function toApiOrgCloudProject(row) { return organizationRepository.toApiCloudProject(row); }
async function updateOrgCloudProject(orgId, patch) { return organizationRepository.updateCloudProject(orgId, patch); }
async function updateSystemAgentPrompt(orgId, agentId, prompt) { return organizationRepository.updateSystemAgentPrompt(orgId, agentId, prompt); }
async function retainOrgCloudProject(orgId, organizationName) { return organizationRepository.markCloudProjectRetained(orgId, organizationName); }
async function listOrgCloudProjectsByStatus(statuses) { return organizationRepository.listCloudProjectsByStatus(statuses); }

// Adds `seconds` worth of usage to an org's metered AI minutes. Read-modify-
// write, not an atomic SQL increment — for genuinely concurrent calls on the
// same org this can under-count under a race. Acceptable for a first-cut
// usage counter; a real billing system should use a MySQL RPC that does
// `ai_minutes_used = ai_minutes_used + x` in one statement instead.
// Shared raw pool for billing modules that need row-level transactions.
// Exported intentionally so reservation/recharge operations can use the same
// MySQL connection pool as the rest of the repository without a second pool.
async function incrementAiMinutesUsed(orgId, seconds) {
  if (!orgId || !seconds) return;
  const minutes = seconds / 60;
  await _pool.query(`UPDATE organizations SET ai_minutes_used = COALESCE(ai_minutes_used, 0) + $1 WHERE id = $2`, [minutes, orgId]);
  const { rows } = await _pool.query(`SELECT * FROM organizations WHERE id = $1`, [orgId]);
  return rows[0] ? orgRowToApi(rows[0]) : null;
}

// Same read-modify-write pattern as incrementAiMinutesUsed, for the
// telephony-provider side of the bill (organizations.phone_charges) —
// previously nothing ever wrote to this column at all, so it sat frozen
// at 0 for every real org while the Billing & Usage page displayed it as
// if it were live. Requires platform/pricing.js lazily (function-local,
// not a top-level require) — pricing.js -> platform/settings.js ->
// db/repository.js would otherwise be a circular require back into this
// same file, which is still loading its own module.exports at that
// point.
async function incrementPhoneCharges(orgId, seconds) {
  if (!orgId || !seconds) return;
  const { phoneCostForSeconds } = require("../platform/pricing");
  const charge = await phoneCostForSeconds(seconds);
  if (!charge) return;
  await _pool.query(`UPDATE organizations SET phone_charges = COALESCE(phone_charges, 0) + $1 WHERE id = $2`, [charge, orgId]);
  const { rows } = await _pool.query(`SELECT * FROM organizations WHERE id = $1`, [orgId]);
  return rows[0] ? orgRowToApi(rows[0]) : null;
}

// ------------------------------------------------------------
// Org membership (team) — signup / invite / lookup helpers
// beyond the generic list/create/patch/remove above
// ------------------------------------------------------------

async function updateOrgMemberUserId(orgId, memberId, userId) {
  if (!userId) throw new Error("[db.updateOrgMemberUserId] userId is required");
  const { data, error } = await supabase
    .from("org_members")
    .update({ user_id: userId })
    .eq("org_id", orgId)
    .eq("id", memberId)
    .select()
    .single();
  if (error) throw new Error(`[db.updateOrgMemberUserId] ${error.message}`);
  return fromDbRow("team", data);
}

async function addOrgMember(orgId, userId, { name, email, phone, role, feature_flags } = {}) {
  const normalizedEmail = email ? email.toLowerCase() : email;
  const { data, error } = await supabase
    .from("org_members")
    .insert({
      org_id: orgId,
      user_id: userId || null,
      name,
      email: normalizedEmail,
      phone: phone || null,
      role: role || "Organization Admin",
      feature_flags: feature_flags || [],
    })
    .select()
    .single();
  if (error) throw new Error(`[db.addOrgMember] ${error.message}`);
  return fromDbRow("team", data);
}

async function signInWithPassword(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

// Auto-redial policy for outbound calls that ended in "No Answer" or
// "Answering Machine" — shared by both places a call can end that way
// (server.js's Hangup webhook for calls that never connected, and
// vobizProxy.js's processPostCallData for machine-detected ones) and by
// services/dialerRetryEngine.js, which schedules the next actual redial.
const MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_POLICY = Object.freeze({
  enabled: true,
  strategy: "exponential",
  intervalMinutes: 120,
  maxRetries: 3,
  quietHoursStart: "21:00",
  quietHoursEnd: "08:00",
});

function normalizeRetryPolicy(policy = {}) {
  const strategy = policy.strategy === "fixed" ? "fixed" : "exponential";
  const intervalMinutes = Math.max(15, Math.min(24 * 60, Number(policy.intervalMinutes) || DEFAULT_RETRY_POLICY.intervalMinutes));
  const maxRetries = Math.max(0, Math.min(10, Number.isFinite(Number(policy.maxRetries)) ? Number(policy.maxRetries) : DEFAULT_RETRY_POLICY.maxRetries));
  return {
    ...DEFAULT_RETRY_POLICY,
    ...policy,
    enabled: policy.enabled !== false,
    strategy,
    intervalMinutes,
    maxRetries,
    quietHoursStart: /^([01]\\d|2[0-3]):[0-5]\\d$/.test(String(policy.quietHoursStart || "")) ? policy.quietHoursStart : DEFAULT_RETRY_POLICY.quietHoursStart,
    quietHoursEnd: /^([01]\\d|2[0-3]):[0-5]\\d$/.test(String(policy.quietHoursEnd || "")) ? policy.quietHoursEnd : DEFAULT_RETRY_POLICY.quietHoursEnd,
  };
}

function localDateTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")), minute: Number(get("minute")), second: Number(get("second")) };
}

function addLocalDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextRetryTime({ attemptNumber, policy, callerPhone }) {
  const p = normalizeRetryPolicy(policy);
  if (!p.enabled || p.maxRetries <= 0 || attemptNumber > p.maxRetries) return null;

  const multiplier = p.strategy === "fixed" ? 1 : Math.pow(2, Math.max(0, attemptNumber - 1));
  const delayMinutes = Math.min(7 * 24 * 60, p.intervalMinutes * multiplier);
  let target = new Date(Date.now() + delayMinutes * 60 * 1000);

  try {
    const { getCallerTimezone } = require("../lib/callerTimezone");
    const { zonedTimeToUtc } = require("../lib/timezoneConvert");
    const timeZone = getCallerTimezone(callerPhone);
    const local = localDateTimeParts(target, timeZone);
    const [startH, startM] = p.quietHoursStart.split(":").map(Number);
    const [endH, endM] = p.quietHoursEnd.split(":").map(Number);
    const minutes = local.hour * 60 + local.minute;
    const start = startH * 60 + startM;
    const end = endH * 60 + endM;
    const inQuiet = start > end ? minutes >= start || minutes < end : minutes >= start && minutes < end;
    if (inQuiet) {
      const targetDate = minutes >= start && start > end ? addLocalDays(local.date, 1) : local.date;
      target = zonedTimeToUtc(`${targetDate}T${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00`, timeZone) || target;
    }
  } catch (_) {}
  return target.toISOString();
}

function computeRetryFields(attemptNumber, policy = DEFAULT_RETRY_POLICY, callerPhone = null) {
  const p = normalizeRetryPolicy(policy);
  if (!p.enabled || attemptNumber > p.maxRetries) {
    return { attemptNumber, retryStatus: "exhausted", nextRetryAt: null, retryClaimedAt: null };
  }
  return {
    attemptNumber,
    retryStatus: "pending",
    nextRetryAt: nextRetryTime({ attemptNumber, policy: p, callerPhone }),
    retryClaimedAt: null,
  };
}

// Org-scoped view of which phone numbers currently have an auto-redial in
// flight or exhausted, for the dashboard to show next to "No Answer"/
// "Answering Machine" rows (services/dialerRetryEngine.js does the actual
// redialing; this is read-only for display).
async function getRetryStatusForOrg(orgId) {
  const { data, error } = await supabase
    .from("call_logs")
    .select("lead_name, caller_number, status, attempt_number, next_retry_at, retry_status, retry_context")
    .eq("org_id", orgId)
    .in("retry_status", ["pending", "retrying", "retried", "exhausted"])
    .order("created_at", { ascending: false });
  if (error) throw new Error(`[db.getRetryStatusForOrg] ${error.message}`);
  // lead_name is the matched CONTACT's name when this call resolved to a
  // real lead (see callFinalizer.js), not necessarily a phone number —
  // the frontend looks this row up by normalized phone
  // (DialerSimulator.tsx's retryStatuses[normalizePhone(...)]), so a name
  // here would make the lookup silently never match. caller_number is
  // reliably the actual number regardless.
  return (data || []).map((row) => ({
    phone: row.caller_number || row.lead_name,
    status: row.status,
    attemptNumber: row.attempt_number,
    nextRetryAt: row.next_retry_at,
    retryStatus: row.retry_status,
    retryConfig: row.retry_context?.retryPolicy || DEFAULT_RETRY_POLICY,
  }));
}

// Whether a call to this phone (within this org) more recent than
// `sinceIso` already exists — used by services/dialerRetryEngine.js to
// avoid redialing a lead who already got reached through another path
// (a manual "Redial" click, a different pending retry chain for the same
// number, or the lead having called back in the meantime). Without this,
// multiple independent retry chains for the same number can run in
// parallel forever, and a stale "pending" row keeps firing even after the
// lead was already successfully reached.
async function hasNewerCallForPhone(orgId, phone, sinceIso, excludeId, campaignTaskId = null) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return false;
  // The query-builder shim (services/mysqlClient.js) doesn't implement
  // .gt() — only .gte()/.lte() — so use .gte() and exclude the row itself
  // by id client-side instead of relying on a strict "greater than".
  const { data, error } = await supabase
    .from("call_logs")
    .select("id, lead_name, caller_number, created_at, retry_context")
    .eq("org_id", orgId)
    .gte("created_at", sinceIso);
  if (error) throw new Error(`[db.hasNewerCallForPhone] ${error.message}`);
  const last10 = digits.slice(-10);
  const scopedTaskId = campaignTaskId ? String(campaignTaskId) : null;
  return (data || []).some((row) => {
    if (row.id === excludeId) return false;
    if (!String(row.caller_number || row.lead_name || "").replace(/[^\d]/g, "").endsWith(last10)) return false;
    if (scopedTaskId) {
      const rowTaskId = row.retry_context?.taskId ? String(row.retry_context.taskId) : null;
      if (rowTaskId && rowTaskId !== scopedTaskId) return false;
    }
    return true;
  });
}

// Cross-org scan for outbound calls whose auto-redial delay has elapsed —
// see services/dialerRetryEngine.js. Unscoped (no org_id filter) since the
// retry loop runs on its own timer, not inside a per-org request.
async function claimAutoDialLead(orgId, taskId, leadId) {
  // leadId is a lead's `leads.id` — client-generated (see
  // frontend/src/lib/ids.ts:newClientId), not an RFC-4122 UUID, so this
  // only rejects empty/missing values. Every other clause below still
  // scopes strictly by org_id ($1), so a non-UUID (or malformed) leadId
  // can at most fail to match any row for this org — it cannot widen
  // access to another org's data.
  if (!String(leadId || "").trim()) {
    throw new Error("[db.claimAutoDialLead] invalid lead id");
  }
  const nowIso = new Date().toISOString();
  const client = await _pool.connect();
  try {
    const updateResult = await client.query(`UPDATE dialer_tasks SET current_lead_id = $3, auto_dial_status = 'dialing', current_call_started_at = NOW(), updated_at = NOW()
      WHERE id = $2 AND org_id = $1 AND auto_dial_enabled = true AND current_lead_id IS NULL
      AND (next_dial_at IS NULL OR next_dial_at <= $4)
      AND EXISTS (SELECT 1 FROM leads AS l WHERE l.id = $3 AND l.org_id = $1)
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(call_results, CONCAT('$.', JSON_QUOTE($3), '.status'))), 'Pending') = 'Pending'`, [orgId, taskId, leadId, nowIso]);
    // The UPDATE itself is the compare-and-set claim. If another scheduler
    // instance won the row first, affectedRows is 0 and this worker must not
    // read the row and accidentally treat the other worker's claim as its own.
    if (Number(updateResult.affectedRows || updateResult.rowCount || 0) !== 1) return null;
    const { rows } = await client.query(`SELECT * FROM dialer_tasks WHERE id = $1 AND org_id = $2 AND current_lead_id = $3`, [taskId, orgId, leadId]);
    if (!rows[0]) return null;
    return { ...fromDbRow('dialertasks', rows[0]), orgId };
  } finally { client.release(); }
}

async function recoverStaleRetryClaims() {
  const cutoff = new Date(Date.now() - Number(process.env.DIALER_RETRY_CLAIM_LEASE_MS || 10 * 60 * 1000)).toISOString();
  const { data, error } = await supabase
    .from("call_logs")
    .update({ retry_status: "pending", retry_claimed_at: null })
    .eq("retry_status", "retrying")
    .lte("retry_claimed_at", cutoff)
    .select("id, org_id");
  if (error) throw new Error(`[db.recoverStaleRetryClaims] ${error.message}`);
  return (data || []).length;
}

async function claimCallForRetry(orgId, rowId) {
  const nowIso = new Date().toISOString();
  const client = await _pool.connect();
  try {
    // MySQL rejects UPDATE call_logs ... WHERE NOT EXISTS (SELECT ... FROM call_logs ...)
    // when the subquery correlates to the target row (Error 1093). Wrap the
    // inner scan in a derived table so the existence check is evaluated safely.
    const updateResult = await client.query(`UPDATE call_logs AS c SET retry_status = 'retrying', retry_claimed_at = $4
      WHERE c.id = $2 AND c.org_id = $1 AND c.retry_status = 'pending'
      AND c.next_retry_at <= $3
      AND c.status IN ('No Answer','Answering Machine','Callback Scheduled')
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT newer.id
          FROM call_logs AS newer
          WHERE newer.org_id = c.org_id
            AND newer.id <> c.id
            AND newer.created_at > c.created_at
            AND REGEXP_REPLACE(COALESCE(newer.caller_number, newer.lead_name, ''), '[^0-9]', '')
              = REGEXP_REPLACE(COALESCE(c.caller_number, c.lead_name, ''), '[^0-9]', '')
            AND (
              JSON_UNQUOTE(JSON_EXTRACT(c.retry_context, '$.taskId')) IS NULL
              OR JSON_UNQUOTE(JSON_EXTRACT(c.retry_context, '$.taskId')) = ''
              OR JSON_UNQUOTE(JSON_EXTRACT(newer.retry_context, '$.taskId')) IS NULL
              OR JSON_UNQUOTE(JSON_EXTRACT(newer.retry_context, '$.taskId')) = ''
              OR JSON_UNQUOTE(JSON_EXTRACT(newer.retry_context, '$.taskId'))
                = JSON_UNQUOTE(JSON_EXTRACT(c.retry_context, '$.taskId'))
            )
        ) AS newer_call_for_same_number
      )`, [orgId, rowId, nowIso, nowIso]);
    // Compare-and-set semantics: exactly one worker can transition pending -> retrying.
    if (Number(updateResult.affectedRows || updateResult.rowCount || 0) !== 1) return null;
    const { rows } = await client.query(`SELECT * FROM call_logs WHERE id = $1 AND org_id = $2 AND retry_status = 'retrying'`, [rowId, orgId]);
    if (!rows[0]) return null;
    return { ...fromDbRow('calllogs', rows[0]), orgId };
  } finally { client.release(); }
}

async function getCallsDueForRetry() {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("call_logs")
    .select("*")
    .in("status", ["No Answer", "Answering Machine", "Callback Scheduled"])
    .eq("retry_status", "pending")
    .lte("next_retry_at", nowIso);
  if (error) throw new Error(`[db.getCallsDueForRetry] ${error.message}`);
  return (data || []).map((row) => ({ ...fromDbRow("calllogs", row), orgId: row.org_id }));
}

const PENDING_SCHEDULE_STATUSES = ["Callback Scheduled", "No Answer", "Answering Machine"];

// When a call is finalized, retire other pending retry rows for the same
// provider call / lead so Scheduled Callbacks never shows callback + no-answer twice.
async function supersedeConflictingPendingCallLogs(orgId, keepRow) {
  if (!orgId || !keepRow?.id) return;
  const { data, error } = await supabase
    .from("call_logs")
    .select("*")
    .eq("org_id", orgId)
    .in("status", PENDING_SCHEDULE_STATUSES)
    .eq("retry_status", "pending");
  if (error) throw new Error(`[db.supersedeConflictingPendingCallLogs] ${error.message}`);

  const keepRank = SCHEDULE_STATUS_RANK[keepRow.status] || 0;
  for (const raw of data || []) {
    const row = fromDbRow("calllogs", raw);
    if (row.id === keepRow.id) continue;
    if (!pendingScheduleRowsConflict(keepRow, row)) continue;
    const rowRank = SCHEDULE_STATUS_RANK[row.status] || 0;
    if (keepRank < rowRank) continue;
    await patch("calllogs", orgId, row.id, {
      retryStatus: "exhausted",
      nextRetryAt: null,
    });
    log.info(
      `♻️ Superseded duplicate pending schedule row ${row.id} (${row.status}) in favor of ${keepRow.id} (${keepRow.status})`
    );
  }
}

// Every call currently sitting in "Callback Scheduled", "No Answer", or
// "Answering Machine" for this org, still pending an automatic redial —
// not just the ones due right now (getCallsDueForRetry above), the whole
// queue so it's visible ahead of time. Enriched with the originating
// dialer task's workflow name/questions where one exists
// (retryContext.taskId; absent for inbound calls, which have no dialer
// task/campaign at all). Powers the Scheduled Callbacks tab: a caller who
// explicitly asked for a callback is shown with a reason (why); a call
// nobody picked up for is shown too — "kind" distinguishes the two so the
// frontend can chip them "Callback" vs "Not Answered" instead of lumping
// every pending redial under one label.
async function getScheduledCallbacks(orgId) {
  const { data, error } = await supabase
    .from("call_logs")
    .select("*")
    .eq("org_id", orgId)
    .in("status", ["Callback Scheduled", "No Answer", "Answering Machine"])
    .eq("retry_status", "pending")
    .order("next_retry_at", { ascending: true });
  if (error) throw new Error(`[db.getScheduledCallbacks] ${error.message}`);
  const allRows = (data || []).map((row) => fromDbRow("calllogs", row));
  const rows = dedupePendingScheduleRows(allRows);
  await reconcilePendingScheduleDuplicates(orgId, allRows, rows);

  const taskIds = [...new Set(rows.map((r) => r.retryContext?.taskId).filter(Boolean))];
  let tasksById = {};
  if (taskIds.length) {
    const tasks = await list("dialertasks", orgId);
    tasksById = Object.fromEntries(tasks.filter((t) => taskIds.includes(t.id)).map((t) => [t.id, t]));
  }

  const { getCallerTimezone } = require("../lib/callerTimezone");
  const { formatInstantInTimezone } = require("../lib/timezoneConvert");

  return rows.map((row) => {
    const task = row.retryContext?.taskId ? tasksById[row.retryContext.taskId] : null;
    const kind = row.status === "Callback Scheduled" ? "callback" : "not_answered";
    const reason = row.status === "Callback Scheduled"
      ? (row.callbackReason || "Caller asked to be called back.")
      : row.status === "Answering Machine"
        ? "Reached voicemail / an answering machine — no live conversation."
        : "Call went unanswered.";
    const callerTimezone = getCallerTimezone(row.callerNumber);
    const scheduleIso = row.callbackTime || row.nextRetryAt;
    return {
      ...row,
      kind,
      reason,
      callerTimezone,
      callbackTimeLocalLabel: formatInstantInTimezone(row.callbackTime || row.nextRetryAt, callerTimezone),
      nextRetryAtLocalLabel: formatInstantInTimezone(row.nextRetryAt, callerTimezone),
      scheduleLocalLabel: formatInstantInTimezone(scheduleIso, callerTimezone),
      // Link retries to the dialer task (campaign) that placed the original
      // call — not question_flows/workflow_id alone, since the same workflow
      // can be reused across multiple campaigns created at different times.
      campaignId: task?.id || row.retryContext?.taskId || null,
      campaignName: task?.name || null,
      // Back-compat for older clients that still read workflowName.
      workflowName: task?.name || null,
      campaignQuestions: task?.questions || row.retryContext?.questions || [],
      workflowQuestions: task?.questions || row.retryContext?.questions || [],
    };
  });
}

// Cross-org pending retry scan used only by the durable callback scheduler.
// MySQL remains the source of truth; BullMQ only stores durable wake-up jobs.
async function getPendingRetriesForScheduler(limit = 5000) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 10000));
  const { data, error } = await supabase
    .from("call_logs")
    .select("*")
    .in("status", ["Callback Scheduled", "No Answer", "Answering Machine"])
    .eq("retry_status", "pending")
    .order("next_retry_at", { ascending: true })
    .limit(safeLimit);
  if (error) throw new Error(`[db.getPendingRetriesForScheduler] ${error.message}`);
  return (data || []).map((row) => fromDbRow("calllogs", row));
}

// Cross-org scan for dialer tasks currently in auto-dial mode — see
// src/crm/autoDialEngine.js. Unscoped (no org_id filter), same rationale
// as getCallsDueForRetry above: the engine runs on its own timer, not
// inside a per-org request. Returns every task that either still has work
// to do (auto_dial_enabled) or has an outbound call in flight that needs
// to be checked for completion (current_provider_call_sid set) — a task
// that was just stopped mid-call still needs that one last call's outcome
// recorded even though auto_dial_enabled is now false.
async function getActiveAutoDialTasks() {
  // The query-builder shim (src/db/adapters/mysql.js) only ANDs filters
  // together — no .or() — so an "enabled OR has an in-flight call" query
  // can't be expressed in one call. Dialer task row counts are small
  // (one row per campaign-dial task, not per lead), so filtering the full
  // table in JS is simpler and cheap.
  const { data, error } = await supabase.from("dialer_tasks").select("*");
  if (error) throw new Error(`[db.getActiveAutoDialTasks] ${error.message}`);
  return (data || [])
    .filter((row) => row.auto_dial_enabled || row.current_provider_call_sid)
    .map((row) => ({ ...fromDbRow("dialertasks", row), orgId: row.org_id }));
}

// Single-lead lookup by id, org-scoped — autoDialEngine.js needs this to
// resolve a task's next lead id (from lead_ids) to an actual phone number
// without a per-request org context to call db.list("leads", ...) through
// a route handler.
async function getLeadById(orgId, id) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .single();
  if (error) return null; // not found (or any other read error) — caller treats this as "skip this lead"
  return fromDbRow("leads", data);
}

// Single-team-member lookup by id, org-scoped — same rationale as
// getLeadById: autoDialEngine.js needs to resolve a task's
// assignedTeamMemberId to a name/phone with no per-request context.
async function getTeamMemberById(orgId, id) {
  const { data, error } = await supabase
    .from("org_members")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .single();
  if (error) return null;
  return fromDbRow("team", data);
}

// Finds the call_logs row for a specific outbound call this org's
// auto-dial engine placed, by the telephony provider's own call id
// (Vobiz CallUUID / Twilio CallSid / Piopiy call id) — see
// callFinalizer.js's providerCallSid. A row existing means that call has
// finished (finalizeCallRecord already ran); no row means it's still in
// progress. Returns null either way it can't be found, so the engine
// treats "not found" and "still ringing" identically (keep waiting).
async function findCallLogByProviderCallSid(orgId, providerCallSid) {
  if (!providerCallSid) return null;
  const { data, error } = await supabase
    .from("call_logs")
    .select("*")
    .eq("org_id", orgId)
    .eq("provider_call_sid", providerCallSid)
    .limit(1);
  if (error) throw new Error(`[db.findCallLogByProviderCallSid] ${error.message}`);
  return (data && data[0]) ? fromDbRow("calllogs", data[0]) : null;
}

async function getCallLogById(orgId, callId) {
  if (!orgId || !callId) return null;
  const { data, error } = await supabase
    .from("call_logs")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", callId)
    .limit(1);
  if (error) throw new Error(`[db.getCallLogById] ${error.message}`);
  return (data && data[0]) ? fromDbRow("calllogs", data[0]) : null;
}

async function reconcilePendingScheduleDuplicates(orgId, allRows, winners) {
  if (!orgId || !Array.isArray(allRows) || !Array.isArray(winners)) return;
  const winnerIds = new Set(winners.map((row) => row.id));
  for (const row of allRows) {
    if (winnerIds.has(row.id)) continue;
    if (!winners.some((winner) => pendingScheduleRowsConflict(winner, row))) continue;
    await patch("calllogs", orgId, row.id, {
      retryStatus: "exhausted",
      nextRetryAt: null,
    });
    log.info(`♻️ Retired duplicate pending schedule row ${row.id} (${row.status}) during scheduled-callbacks read`);
  }
}

// Resolve which org owns a virtual number, so inbound call webhooks (which
// carry a dialed "To" number but no auth context) can be tagged with the
// right org. Returns null if not configured, or if the number isn't
// registered under Settings > Numbers for any org yet.
async function findOrgIdForNumber(number) {
  if (!number) return null;
  const digitsOnly = String(number).replace(/[^\d]/g, "");
  if (!digitsOnly) return null;
  const { data, error } = await supabase
    .from("virtual_numbers")
    .select("org_id, number");
  if (error) throw new Error(`[db.findOrgIdForNumber] ${error.message}`);
  const matches = (data || []).filter((row) => String(row.number).replace(/[^\d]/g, "").endsWith(digitsOnly.slice(-10)));
  if (matches.length > 1) {
    // Two orgs somehow ended up owning the same number — routing an inbound
    // call to whichever row happens to come back first would silently
    // misroute the other org's calls. isNumberAvailable() below is meant to
    // stop this at write time, but flag loudly if it ever happens anyway.
    log.error(`❌ [db.findOrgIdForNumber] Number "${number}" matches ${matches.length} orgs (${matches.map((m) => m.org_id).join(", ")}) — routing to the first match, but this indicates a duplicate virtual_numbers row that should be fixed.`);
  }
  return matches.length ? matches[0].org_id : null;
}

// Whether `number` is free to assign to `orgId` — false if another org
// already owns a number whose last 10 digits match (same normalization
// findOrgIdForNumber uses for inbound routing, so "available" here really
// means "won't collide with call routing").
async function isNumberAvailable(number, orgId) {
  const existingOrgId = await findOrgIdForNumber(number);
  if (existingOrgId && existingOrgId !== orgId) return false;

  // Vobiz channel rows are globally unique by type + external_id. A number
  // can therefore remain reserved even after its virtual_numbers row was
  // removed (for example, after an older/stale disconnect). Check channels
  // too so we never pass the availability check and then hit a DB duplicate
  // key during channelsEngine.upsertChannel().
  if (number) {
    const digitsOnly = String(number).replace(/[^\\d]/g, "");
    if (digitsOnly) {
      const { data: channels, error } = await supabase
        .from("channels")
        .select("org_id, external_id")
        .eq("type", "vobiz");
      if (error) throw new Error("[db.isNumberAvailable] " + error.message);
      const last10 = digitsOnly.slice(-10);
      const channelMatch = (channels || []).find(
        (row) => String(row.external_id || "").replace(/[^\\d]/g, "").endsWith(last10)
      );
      if (channelMatch && channelMatch.org_id !== orgId) return false;
    }
  }

  return true;
}

// Finds a lending-org lead whose phone matches (last-10-digits, same
// normalization findOrgIdForNumber uses) so an inbound/outbound call can
// be linked to a caller who's already a saved contact, instead of every
// call showing up as a disconnected phone number with no history. Returns
// {id, name} (not just id) so the caller's saved name can also be used
// to greet them by name and skip re-asking for it.
async function findLeadByPhone(orgId, phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, "");
  if (!digits) return null;
  const last10 = digits.slice(-10);
  const { data, error } = await supabase.from("leads").select("id, name, phone").eq("org_id", orgId);
  if (error) throw new Error(`[db.findLeadByPhone] ${error.message}`);
  const match = (data || []).find((row) => String(row.phone || "").replace(/[^\d]/g, "").endsWith(last10));
  return match ? { id: match.id, name: match.name || null } : null;
}

// Looks for a name the caller gave during this specific call — via the
// 'save_enquiry' tool (structured name field) or, failing that, a
// 'save_question_response' answer to a question that was actually asking
// for their name. Used to auto-create a contact for a brand-new caller
// once the call ends, instead of them staying a disconnected phone
// number forever unless someone manually adds them.
async function findCapturedNameForCall(orgId, callId) {
  if (!callId) return null;
  try {
    const { data: enquiries } = await supabase.from("enquiries").select("name").eq("org_id", orgId).eq("call_id", callId);
    const withName = (enquiries || []).find((e) => e.name);
    if (withName) return withName.name;
  } catch (_) {}
  try {
    const { data: responses } = await supabase.from("lead_responses").select("question, answer").eq("org_id", orgId).eq("call_id", callId);
    const nameAnswer = (responses || []).find((r) => /name/i.test(r.question || "") && r.answer);
    if (nameAnswer) return nameAnswer.answer;
  } catch (_) {}
  return null;
}

// Every question/answer pair captured for a phone number, oldest first —
// these get saved during a call (save_question_response tool) but nothing
// ever reads them back out anywhere in the app, so a task's Report view
// has no way to show what a lead actually said. Matches by last-10-digits
// like findLeadByPhone, since the caller-ID format captured mid-call and
// the contact's stored phone format don't always agree on a country code
// prefix.
async function getResponsesByCallId(orgId, callId) {
  const { data, error } = await supabase
    .from("lead_responses")
    .select("question, answer, label, created_at")
    .eq("org_id", orgId)
    .eq("call_id", callId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`[db.getResponsesByCallId] ${error.message}`);
  return (data || []).map(row => ({ label: row.label || row.question, question: row.question, answer: row.answer }));
}

async function getResponsesForPhone(orgId, phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return [];
  const last10 = digits.slice(-10);
  const { data, error } = await supabase
    .from("lead_responses")
    .select("question, answer, label, call_id, policyholder_phone, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`[db.getResponsesForPhone] ${error.message}`);
  return (data || [])
    .filter((row) => String(row.policyholder_phone || "").replace(/[^\d]/g, "").endsWith(last10))
    .map((row) => ({ label: row.label || row.question, question: row.question, answer: row.answer, callId: row.call_id, createdAt: row.created_at }));
}

// Given an application auth user id, find the org they belong to.
// Returns null if not configured (dev fallback) or no membership found.
async function findOrgIdForUser(userId) {
  const membership = await findMembershipForUser(userId);
  return membership ? membership.orgId : null;
}

// Same lookup but also returns the member's role, so request middleware
// can do role-based access checks without a second round trip.
async function findMembershipForUser(userId, email) {
  // First try: match by Keycloak sub (user_id column)
  const { data, error } = await supabase
    .from("org_members")
    .select("id, org_id, role, name, feature_flags")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`[db.findMembershipForUser] ${error.message}`);
  if (data) return { orgId: data.org_id, role: data.role, name: data.name, featureFlags: data.feature_flags || [] };

  // Fallback: match by email for members added before auth was set up.
  // Auto-link their row to the auth sub so future lookups hit the fast path.
  if (!email) return null;
  const { data: byEmail, error: emailErr } = await supabase
    .from("org_members")
    .select("id, org_id, role, name, feature_flags")
    .ilike("email", email.toLowerCase())
    .is("user_id", null)
    .limit(1)
    .maybeSingle();
  log.info(`🔍 findMembershipForUser email lookup — email:${email} found:${!!byEmail} error:${emailErr?.message}`);
  if (emailErr) throw new Error(`[db.findMembershipForUser email] ${emailErr.message}`);
  if (!byEmail) return null;

  // Claim the legacy email-only membership atomically. The NULL predicate is
  // essential: two concurrent logins must not both believe they linked the row.
  const { data: linkedRows, error: linkErr } = await supabase
    .from("org_members")
    .update({ user_id: userId })
    .eq("id", byEmail.id)
    .is("user_id", null)
    .select("id, org_id, role, name, feature_flags")
    .limit(1);

  if (linkErr) {
    // A unique user_id collision means this auth identity is already linked.
    // Never fall back to the email row because that could cross organizations.
    log.error(`[db.findMembershipForUser] auto-link failed: ${linkErr.message}`);
    const { data: existing, error: existingErr } = await supabase
      .from("org_members")
      .select("id, org_id, role, name, feature_flags")
      .eq("user_id", userId)
      .limit(2);
    if (existingErr) throw new Error(`[db.findMembershipForUser existing] ${existingErr.message}`);
    if (existing?.length > 1) throw new Error("[db.findMembershipForUser] auth user has multiple organization memberships");
    if (existing?.[0]) return { orgId: existing[0].org_id, role: existing[0].role, name: existing[0].name, featureFlags: existing[0].feature_flags || [] };
    return null;
  }

  const linked = linkedRows?.[0];
  if (linked) {
    log.info(`🔗 Linked auth user ${userId} to org_member ${linked.id}`);
    return { orgId: linked.org_id, role: linked.role, name: linked.name, featureFlags: linked.feature_flags || [] };
  }

  // Another request won the race. Re-read by the immutable auth subject and
  // use that row only; never trust the originally selected email row.
  const { data: existing, error: existingErr } = await supabase
    .from("org_members")
    .select("id, org_id, role, name, feature_flags")
    .eq("user_id", userId)
    .limit(2);
  if (existingErr) throw new Error(`[db.findMembershipForUser existing] ${existingErr.message}`);
  if (existing?.length > 1) throw new Error("[db.findMembershipForUser] auth user has multiple organization memberships");
  if (!existing?.[0]) return null;
  return { orgId: existing[0].org_id, role: existing[0].role, name: existing[0].name, featureFlags: existing[0].feature_flags || [] };
}

// ------------------------------------------------------------
// Questionnaire (singleton per org) — the voice-agent's list of
// lead-qualification questions for the insurance/lending vertical
// ------------------------------------------------------------

// Lending's own default questionnaire — every other industry's defaults
// live in industryPacks.js instead (DEFAULT_QUESTIONS there), seeded per
// org at signup (authRoutes.js's seedIndustryQuestions). This is only the
// fallback for lending orgs (or orgs with no industry set at all) that
// somehow have no questionnaires row yet.
const DEFAULT_QUESTIONS = [
  "Unga full name enna, sollunga?",
  "Ugaluku enna maadhiri insurance coverage venum?",
  "Unga budget premium target enna?",
  "Ugaluku edhavadhu pre-existing health conditions or medical issues iruka?"
];

async function getQuestions(orgId) {
  const { data, error } = await supabase
    .from("questionnaires")
    .select("questions")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`[db.getQuestions] ${error.message}`);
  if (data) return data.questions;

  // No questionnaire saved yet — fall back to this org's real industry
  // defaults instead of always returning the lending/insurance set
  // regardless of what industry the org actually is.
  const org = await getOrg(orgId).catch(() => null);
  const industryDefaults = org?.industry ? industryPacks.getDefaultQuestions(org.industry) : null;
  return industryDefaults || DEFAULT_QUESTIONS;
}

async function updateQuestions(orgId, questions) {
  const { data, error } = await supabase
    .from("questionnaires")
    .upsert({ org_id: orgId, questions, updated_at: new Date().toISOString() })
    .select("questions")
    .single();
  if (error) throw new Error(`[db.updateQuestions] ${error.message}`);
  return data.questions;
}

// ── Per-org agents ────────────────────────────────────────────────────────────

function agentFromRow(row) {
  return {
    id:                row.id,
    orgId:             row.org_id,
    name:              row.name,
    systemPrompt:      row.system_prompt,
    activeVoice:       row.active_voice,
    emotion:           row.emotion,
    speed:             row.speed,
    friendliness:      row.friendliness,
    language:          row.language,
    industry:          row.industry ?? null,
    dialect:           row.dialect ?? null,
    businessContext:   row.business_context ?? null,
    callType:          row.call_type ?? "INBOUND",
    phoneNumberId:     row.phone_number_id,
    outboundNumberId:  row.outbound_number_id ?? null,
    active:            row.active ?? true,
    // 'all' (default, whole org knowledge base — matches pre-existing
    // behavior for every agent created before this field existed),
    // 'specific' (only knowledgeBaseDocumentIds), or 'none' (disabled).
    knowledgeBaseMode:        row.knowledge_base_mode ?? "all",
    knowledgeBaseDocumentIds: row.knowledge_base_document_ids ?? [],
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
  };
}

async function listAgents(orgId, options = {}) {
  const { page, limit } = options;
  const paginate = Number.isInteger(page) && Number.isInteger(limit) && page > 0 && limit > 0;
  let query = supabase
    .from("org_agents")
    .select("*", paginate ? { count: "exact" } : undefined)
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (paginate) {
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1);
  }
  const { data, error, count } = await query;
  if (error) throw new Error(`[db.listAgents] ${error.message}`);
  const rows = (data || []).map(agentFromRow);
  return paginate ? { rows, total: count ?? rows.length } : rows;
}

async function createAgent(orgId, fields) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("org_agents")
    .insert({
      org_id:        orgId,
      name:          fields.name,
      system_prompt: fields.systemPrompt ?? null,
      active_voice:  fields.activeVoice ?? "Arjun",
      emotion:       fields.emotion ?? 78,
      speed:         fields.speed ?? 52,
      friendliness:  fields.friendliness ?? 82,
      language:      fields.language ?? "en",
      active:        fields.active ?? true,
      industry:          fields.industry ?? null,
      dialect:           fields.dialect ?? null,
      business_context:  fields.businessContext ?? null,
      call_type:         fields.callType ?? "INBOUND",
      knowledge_base_mode:         fields.knowledgeBaseMode ?? "all",
      knowledge_base_document_ids: fields.knowledgeBaseDocumentIds ?? [],
      created_at:    now,
      updated_at:    now,
    })
    .select()
    .single();
  if (error) throw new Error(`[db.createAgent] ${error.message}`);
  return agentFromRow(data);
}

/** Enable or disable an agent — disabled agents are skipped by inbound
 *  routing (getAgentForNumber) and hidden from outbound agent pickers. */
async function setAgentActive(agentId, orgId, active) {
  const { data, error } = await supabase
    .from("org_agents")
    .update({ active: !!active, updated_at: new Date().toISOString() })
    .eq("id", agentId)
    .eq("org_id", orgId)
    .select()
    .single();
  if (error) throw new Error(`[db.setAgentActive] ${error.message}`);
  return agentFromRow(data);
}

async function getAgent(agentId, orgId) {
  const { data, error } = await supabase
    .from("org_agents")
    .select("*")
    .eq("id", agentId)
    .eq("org_id", orgId)
    .single();
  if (error) return null;
  return agentFromRow(data);
}

async function updateAgent(agentId, orgId, fields) {
  const patch = { updated_at: new Date().toISOString() };
  if (fields.name          !== undefined) patch.name          = fields.name;
  if (fields.systemPrompt  !== undefined) patch.system_prompt = fields.systemPrompt;
  if (fields.activeVoice   !== undefined) patch.active_voice  = fields.activeVoice;
  if (fields.emotion       !== undefined) patch.emotion       = fields.emotion;
  if (fields.speed         !== undefined) patch.speed         = fields.speed;
  if (fields.friendliness  !== undefined) patch.friendliness  = fields.friendliness;
  if (fields.language      !== undefined) patch.language      = fields.language;
  if (fields.industry         !== undefined) patch.industry          = fields.industry;
  if (fields.dialect          !== undefined) patch.dialect           = fields.dialect;
  if (fields.businessContext  !== undefined) patch.business_context  = fields.businessContext;
  if (fields.callType         !== undefined) patch.call_type         = fields.callType;
  if (fields.knowledgeBaseMode        !== undefined) patch.knowledge_base_mode        = fields.knowledgeBaseMode;
  if (fields.knowledgeBaseDocumentIds !== undefined) patch.knowledge_base_document_ids = fields.knowledgeBaseDocumentIds;
  const { data, error } = await supabase
    .from("org_agents")
    .update(patch)
    .eq("id", agentId)
    .eq("org_id", orgId)
    .select()
    .single();
  if (error) throw new Error(`[db.updateAgent] ${error.message}`);
  return agentFromRow(data);
}

/** Set (or clear) the preferred outbound number for an agent.
 *  Many agents may share the same outbound number — no exclusivity enforced.
 *  Uses raw pg to avoid Supabase REST type-coercion on outbound_number_id
 *  (the column was originally declared UUID but virtual_numbers.id is TEXT). */
async function assignAgentOutboundNumber(agentId, numberId, orgId) {
  // Was raw `_pool.query(...)` on a second, separate Pool from the
  // adapter's own — bypassing the adapter entirely meant it never awaited
  // `ready` (the schema-bootstrap promise every other write here does via
  // supabase.from(...)._exec), never checked rowCount (a 0-row update from
  // a stale id looked identical to success), and had no explicit type
  // cast on the value, unlike every other write in this codebase. Rewritten
  // to go through the same query-builder path assignAgentToNumber (the
  // INBOUND equivalent, which was never reported broken) already uses, so
  // both behave identically instead of one being a special case.
  const { error } = await supabase
    .from("org_agents")
    .update({ outbound_number_id: numberId ?? null, updated_at: new Date().toISOString() })
    .eq("id", agentId)
    .eq("org_id", orgId);
  if (error) throw new Error(`[db.assignAgentOutboundNumber] ${error.message}`);
}

async function deleteAgent(agentId, orgId) {
  // Unlink any phone numbers pointing to this agent first
  await supabase.from("virtual_numbers").update({ agent_id: null }).eq("agent_id", agentId).eq("org_id", orgId);
  const { error } = await supabase.from("org_agents").delete().eq("id", agentId).eq("org_id", orgId);
  if (error) throw new Error(`[db.deleteAgent] ${error.message}`);
}

/** Assign a phone number to an agent (exclusive). Pass numberId=null to unassign. */
async function assignAgentToNumber(agentId, numberId, orgId) {
  // Unassign the number from any other agent first
  if (numberId) {
    await supabase.from("virtual_numbers").update({ agent_id: null }).eq("id", numberId).eq("org_id", orgId);
    const { error } = await supabase
      .from("virtual_numbers")
      .update({ agent_id: agentId })
      .eq("id", numberId)
      .eq("org_id", orgId);
    if (error) throw new Error(`[db.assignAgentToNumber] ${error.message}`);
  } else {
    // Unassign all numbers from this agent
    await supabase.from("virtual_numbers").update({ agent_id: null }).eq("agent_id", agentId).eq("org_id", orgId);
  }
}

/** Returns the agent config for a given phone number, or null if none assigned. */
async function getAgentForNumber(phoneNumber) {
  if (!phoneNumber) return null;
  // NOTE: the mysql.js query-builder shim doesn't implement .not(), so
  // ".not('agent_id','is',null)" used to throw a TypeError on every call —
  // silently caught by every caller's try/catch, which meant this function
  // NEVER actually returned an agent and the inbound "no agent assigned"
  // reject check could never trigger. Do the not-null check in JS instead.
  // Also match on last-10-digits like findOrgIdForNumber does, instead of
  // an exact string match — a provider's "To" can carry a "+91" prefix
  // that doesn't exactly match how the number is stored, which would
  // otherwise make every call look unassigned even when an agent is set.
  const digitsOnly = String(phoneNumber).replace(/[^\d]/g, "");
  if (!digitsOnly) return null;
  const { data: numbers, error: numErr } = await supabase
    .from("virtual_numbers")
    .select("agent_id, org_id, number");
  if (numErr) return null;
  const match = (numbers || []).find((row) =>
    String(row.number).replace(/[^\d]/g, "").endsWith(digitsOnly.slice(-10))
  );
  if (!match || !match.agent_id) return null;
  const { data, error } = await supabase
    .from("org_agents")
    .select("*")
    .eq("id", match.agent_id)
    .single();
  if (error || !data) return null;
  const agent = agentFromRow(data);
  // Disabled agent: fall back to org-level config the same way an
  // unassigned number does, instead of answering with a paused agent.
  if (agent.active === false) return null;
  return agent;
}

/** Returns all virtual_numbers for an org, with agent_id included. */
async function listNumbersWithAgent(orgId) {
  const { data, error } = await supabase
    .from("virtual_numbers")
    .select("id, number, friendly_name, provider, status, agent_id")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return data || [];
}

// ------------------------------------------------------------
// Gemini Live usage/cost tracking (ai_session_usage) — see
// src/ai/geminiUsageTracker.js, which is the only caller. Kept as
// dedicated functions (rather than relying purely on the generic
// create/patch/list) for the two things those don't cover: an org-scoped
// single-row lookup by id, and the aggregate SUM query the reporting
// endpoint needs.
// ------------------------------------------------------------

async function getAiSessionUsage(id, orgId) { return aiUsageRepository.getSession(id, orgId); }
async function getAiUsageSummary(orgId, options = {}) { return aiUsageRepository.getSummary(orgId, options); }
async function getAiUsageByAdmin(orgId, options = {}) { return aiUsageRepository.getByAdmin(orgId, options); }

// ── Org cost archive ────────────────────────────────────────────────────
// A permanent, never-deleted snapshot of an org's final billing figures,
// written right before deleteOrganization wipes the organizations row
// (and its accrued ai_minutes_used/phone_charges counters) plus that
// org's call logs. See platform/admin.js and crm/billingEngine.js's
// getFinalBillingSnapshot. Uses the generic query-builder (not raw SQL)
// so it works the same on both the Supabase and self-hosted MySQL
// adapters.
function costArchiveRowFromSnapshot(snapshot, deletedByEmail) {
  return {
    org_id: snapshot.orgId,
    org_name: snapshot.orgName,
    workspace_name: snapshot.workspaceName,
    industry: snapshot.industry,
    org_created_at: snapshot.orgCreatedAt,
    deleted_by_email: deletedByEmail || null,
    billing_period_end: snapshot.billingPeriodEnd,
    ai_minutes_used: snapshot.aiMinutesUsed,
    cost_per_minute_inr: snapshot.costPerMinuteInr,
    ai_minutes_cost_inr: snapshot.aiMinutesCostInr,
    phone_charges: snapshot.phoneCharges,
    phone_cost_per_minute: snapshot.phoneCostPerMinute,
    call_provider_key: snapshot.callProvider?.key ?? null,
    call_provider_label: snapshot.callProvider?.label ?? null,
    ai_total_tokens: snapshot.aiTokenUsage?.totalTokens ?? 0,
    ai_input_tokens: snapshot.aiTokenUsage?.totalInputTokens ?? 0,
    ai_output_tokens: snapshot.aiTokenUsage?.totalOutputTokens ?? 0,
    ai_call_count: snapshot.aiTokenUsage?.callCount ?? 0,
    ai_session_count: snapshot.aiTokenUsage?.sessionCount ?? 0,
    // Provider/rate identity comes from aiTokenCurrentRate (the rate
    // configured at deletion time, for reference) since aiTokenCost is
    // now a sum of possibly many sessions each locked in at their own,
    // potentially different, historical rate — there's no one rate to
    // attribute the total to.
    ai_token_provider_key: snapshot.aiTokenCurrentRate?.key ?? null,
    ai_token_provider_label: snapshot.aiTokenCurrentRate?.label ?? null,
    ai_token_rate_per_1k: snapshot.aiTokenCurrentRate?.ratePer1kTokens ?? null,
    ai_token_unit: snapshot.aiTokenCurrentRate?.tokenUnit ?? null,
    ai_token_tax_percent: snapshot.aiTokenCurrentRate?.taxPercent ?? null,
    ai_token_base_cost_inr: snapshot.aiTokenCost?.baseCost ?? null,
    ai_token_tax_amount_inr: snapshot.aiTokenCost?.taxAmount ?? null,
    ai_token_total_cost_inr: snapshot.aiTokenCost?.totalCost ?? null,
    snapshot,
    created_at: new Date().toISOString(),
  };
}

function costArchiveRowToApi(row) {
  if (!row) return row;
  return {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    workspaceName: row.workspace_name,
    industry: row.industry,
    orgCreatedAt: row.org_created_at,
    deletedAt: row.deleted_at,
    deletedByEmail: row.deleted_by_email,
    billingPeriodEnd: row.billing_period_end,
    aiMinutesUsed: row.ai_minutes_used,
    costPerMinuteInr: row.cost_per_minute_inr,
    aiMinutesCostInr: row.ai_minutes_cost_inr,
    phoneCharges: row.phone_charges,
    phoneCostPerMinute: row.phone_cost_per_minute,
    callProviderKey: row.call_provider_key,
    callProviderLabel: row.call_provider_label,
    aiTotalTokens: row.ai_total_tokens,
    aiInputTokens: row.ai_input_tokens,
    aiOutputTokens: row.ai_output_tokens,
    aiCallCount: row.ai_call_count,
    aiSessionCount: row.ai_session_count,
    aiTokenProviderKey: row.ai_token_provider_key,
    aiTokenProviderLabel: row.ai_token_provider_label,
    aiTokenRatePer1k: row.ai_token_rate_per_1k,
    aiTokenUnit: row.ai_token_unit,
    aiTokenTaxPercent: row.ai_token_tax_percent,
    aiTokenBaseCostInr: row.ai_token_base_cost_inr,
    aiTokenTaxAmountInr: row.ai_token_tax_amount_inr,
    aiTokenTotalCostInr: row.ai_token_total_cost_inr,
  };
}

async function archiveOrgCost(snapshot, deletedByEmail) {
  const { data, error } = await supabase
    .from("org_cost_archive")
    .insert(costArchiveRowFromSnapshot(snapshot, deletedByEmail))
    .select()
    .single();
  if (error) throw new Error(`[db.archiveOrgCost] ${error.message}`);
  return costArchiveRowToApi(data);
}

async function deleteOrganizationData(orgId, archiveSnapshot = null, deletedByEmail = null) {
  if (!orgId) throw new Error("[db.deleteOrganizationData] orgId is required");

  const client = await _pool.connect();
  try {
    await client.query("BEGIN");

    // The final billing archive must be written inside the SAME transaction
    // as tenant deletion. Otherwise a failed delete can leave a misleading
    // archive, or a successful archive can be duplicated on retry.
    if (archiveSnapshot) {
      const archiveRow = costArchiveRowFromSnapshot(archiveSnapshot, deletedByEmail);
      if (!archiveRow.id) archiveRow.id = require("crypto").randomUUID();
      await client.query(
        `INSERT INTO \`org_cost_archive\` (id, org_id, org_name, workspace_name, industry, org_created_at, deleted_by_email, billing_period_end, ai_minutes_used, cost_per_minute_inr, ai_minutes_cost_inr, phone_charges, phone_cost_per_minute, call_provider_key, call_provider_label, ai_total_tokens, ai_input_tokens, ai_output_tokens, ai_call_count, ai_session_count, ai_token_provider_key, ai_token_provider_label, ai_token_rate_per_1k, ai_token_unit, ai_token_tax_percent, ai_token_base_cost_inr, ai_token_tax_amount_inr, ai_token_total_cost_inr, snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           org_name=VALUES(org_name), workspace_name=VALUES(workspace_name), industry=VALUES(industry),
           org_created_at=VALUES(org_created_at), deleted_by_email=VALUES(deleted_by_email),
           billing_period_end=VALUES(billing_period_end), ai_minutes_used=VALUES(ai_minutes_used),
           cost_per_minute_inr=VALUES(cost_per_minute_inr), ai_minutes_cost_inr=VALUES(ai_minutes_cost_inr),
           phone_charges=VALUES(phone_charges), phone_cost_per_minute=VALUES(phone_cost_per_minute),
           call_provider_key=VALUES(call_provider_key), call_provider_label=VALUES(call_provider_label),
           ai_total_tokens=VALUES(ai_total_tokens), ai_input_tokens=VALUES(ai_input_tokens), ai_output_tokens=VALUES(ai_output_tokens),
           ai_call_count=VALUES(ai_call_count), ai_session_count=VALUES(ai_session_count),
           ai_token_provider_key=VALUES(ai_token_provider_key), ai_token_provider_label=VALUES(ai_token_provider_label),
           ai_token_rate_per_1k=VALUES(ai_token_rate_per_1k), ai_token_unit=VALUES(ai_token_unit),
           ai_token_tax_percent=VALUES(ai_token_tax_percent), ai_token_base_cost_inr=VALUES(ai_token_base_cost_inr),
           ai_token_tax_amount_inr=VALUES(ai_token_tax_amount_inr), ai_token_total_cost_inr=VALUES(ai_token_total_cost_inr),
           snapshot=VALUES(snapshot), created_at=VALUES(created_at)`,
        [archiveRow.id, archiveRow.org_id, archiveRow.org_name, archiveRow.workspace_name, archiveRow.industry,
          archiveRow.org_created_at, archiveRow.deleted_by_email, archiveRow.billing_period_end, archiveRow.ai_minutes_used,
          archiveRow.cost_per_minute_inr, archiveRow.ai_minutes_cost_inr, archiveRow.phone_charges, archiveRow.phone_cost_per_minute,
          archiveRow.call_provider_key, archiveRow.call_provider_label, archiveRow.ai_total_tokens, archiveRow.ai_input_tokens,
          archiveRow.ai_output_tokens, archiveRow.ai_call_count, archiveRow.ai_session_count, archiveRow.ai_token_provider_key,
          archiveRow.ai_token_provider_label, archiveRow.ai_token_rate_per_1k, archiveRow.ai_token_unit, archiveRow.ai_token_tax_percent,
          archiveRow.ai_token_base_cost_inr, archiveRow.ai_token_tax_amount_inr, archiveRow.ai_token_total_cost_inr,
          JSON.stringify(archiveRow.snapshot), archiveRow.created_at]
      );
    }

    // Delete every tenant-owned table in one transaction. The information_schema
    // lookup keeps this list aligned with the actual MySQL schema while the
    // explicit order handles the known parent/child relationships first.
    const preferredOrder = [
      "messages", "lead_responses", "knowledge_chunks", "object_records",
      "object_fields", "object_stages", "workflow_runs", "enquiries", "loans",
      "call_logs", "calls", "inbound_call_logs", "dialer_tasks", "campaigns",
      "workflows", "conversations", "channels", "knowledge_documents", "dnc_entries",
      "orders", "customers", "catalog_items", "leads", "contact_groups",
      "virtual_numbers", "org_agents", "questionnaires", "question_flows",
      "objects", "org_members", "ai_session_usage", "audit_log",
    ];

    const { rows } = await client.query(
      `SELECT DISTINCT TABLE_NAME AS table_name
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND COLUMN_NAME = 'org_id'`
    );
    const existing = new Set((rows || []).map((r) => r.table_name));
    const ordered = [
      ...preferredOrder.filter((table) => existing.has(table)),
      ...[...existing].filter((table) => !preferredOrder.includes(table) && table !== "organizations" && table !== "org_cost_archive"),
    ];

    for (const table of ordered) {
      await client.query(`DELETE FROM \`${table}\` WHERE org_id = ?`, [orgId]);
    }

    // Cloud-project metadata uses organization_id rather than org_id.
    if (existing.has("organization_cloud_projects")) {
      await client.query("DELETE FROM `organization_cloud_projects` WHERE organization_id = ?", [orgId]);
    }

    const orgResult = await client.query("DELETE FROM `organizations` WHERE id = ?", [orgId]);
    if (!orgResult || Number(orgResult.affectedRows || 0) !== 1) {
      throw new Error(`Organization ${orgId} was not found or was already deleted`);
    }

    await client.query("COMMIT");
    return true;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw new Error(`[db.deleteOrganizationData] transaction failed: ${err.message}`);
  } finally {
    client.release();
  }
}

async function listCostArchive() {
  const { data, error } = await supabase
    .from("org_cost_archive")
    .select("*")
    .order("deleted_at", { ascending: false });
  if (error) throw new Error(`[db.listCostArchive] ${error.message}`);
  return (data || []).map(costArchiveRowToApi);
}

async function close() { await closePool(); }

module.exports = {
  isConfigured,
  close,
  supabase,
  list,
  create,
  patch,
  remove,
  replaceAll,
  replaceTeamMembers,
  createOrg,
  createOrganizationSetup,
  getOrg,
  updateOrg,
  updateSystemAgentPrompt,
  createOrgCloudProject,
  getOrgCloudProject,
  getOrgCloudProjectWithCredentials,
  toApiOrgCloudProject,
  updateOrgCloudProject,
  retainOrgCloudProject,
  listOrgCloudProjectsByStatus,
  incrementAiMinutesUsed,
  incrementPhoneCharges,
  getCallsDueForRetry,
  claimAutoDialLead,
  claimCallForRetry,
  recoverStaleRetryClaims,
  getScheduledCallbacks,
  supersedeConflictingPendingCallLogs,
  getPendingRetriesForScheduler,
  getRetryStatusForOrg,
  hasNewerCallForPhone,
  getActiveAutoDialTasks,
  getLeadById,
  getTeamMemberById,
  findCallLogByProviderCallSid,
  getCallLogById,
  getAiSessionUsage,
  getAiUsageSummary,
  getAiUsageByAdmin,
  archiveOrgCost,
  deleteOrganizationData,
  listCostArchive,
  computeRetryFields,
  normalizeRetryPolicy,
  DEFAULT_RETRY_POLICY,
  MAX_RETRY_ATTEMPTS,
  addOrgMember,
  updateOrgMemberUserId,
  findOrgIdForUser,
  findMembershipForUser,
  findOrgIdForNumber,
  findLeadByPhone,
  findCapturedNameForCall,
  getResponsesByCallId,
  getResponsesForPhone,
  isNumberAvailable,
  signInWithPassword,
  getQuestions,
  updateQuestions,
  DEFAULT_QUESTIONS,
  listAgents,
  createAgent,
  getAgent,
  updateAgent,
  deleteAgent,
  assignAgentToNumber,
  assignAgentOutboundNumber,
  setAgentActive,
  getAgentForNumber,
  listNumbersWithAgent,
  // Resolves once CREATE TABLE/ALTER TABLE/CREATE INDEX schema migration
  // has finished (see src/db/adapters/mysql.js's createTables()) — used
  // by src/scheduler/localScheduler.js to hold off registering any cron
  // schedule until the database is actually ready.
  ready: supabase.ready,
  pool: _pool
};
