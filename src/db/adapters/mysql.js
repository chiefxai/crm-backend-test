// ============================================================
// src/db/adapters/mysql.js — Self-hosted MySQL adapter
//
// Implements the application query-builder compatibility surface so existing
// repository and engine modules continue working on MySQL without a broad
// data-access rewrite. Selected when DB_ADAPTER=mysql. See src/db/client.js
// for the factory.
//
//   .from(table).select(cols, {count, head}).eq().in().gte().lte()
//     .order().limit().textSearch().single()/.maybeSingle()
//   .insert(rowOrRows) / .update(row) / .upsert(row) / .delete()
//   .auth.getUser() / .auth.admin.createUser/deleteUser/listUsers()
//   .auth.signInWithPassword()
//
// Schema auto-migration (CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD
// COLUMN IF NOT EXISTS) runs on first require so a fresh MYSQL_URL
// starts up with no manual DDL step.
// ============================================================

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getLogger } = require("../../observability/logger");
const log = getLogger("db.adapters.mysql");

const MYSQL_CONFIGURED = Boolean(process.env.MYSQL_URL || process.env.MYSQL_HOST);
if (!MYSQL_CONFIGURED) {
  throw new Error("[db/adapters/mysql] MySQL configuration is not set");
}

const AUTH_SECRET = process.env.LOCAL_AUTH_SECRET || "chiefvoice-dev-secret-change-me";
if (process.env.NODE_ENV === "production" && AUTH_SECRET === "chiefvoice-dev-secret-change-me") {
  throw new Error("[db/adapters/mysql] LOCAL_AUTH_SECRET must be explicitly configured in production");
}
const AUTH_TOKEN_TTL = "30d";

const { pool, closePool } = require("../pool");

// Identifiers cannot be parameterized with mysql2. Every identifier that
// reaches SQL is therefore validated against the known schema/query-builder
// surface before interpolation. Values continue to use bound parameters.
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdentifier(value, label = "identifier") {
  const name = String(value || "").trim();
  if (!IDENTIFIER_RE.test(name)) throw new Error(`[mysqlClient] Invalid ${label}: ${name}`);
  return name;
}
// Backtick-quote an already-validated identifier so schema columns that
// collide with MySQL reserved words (e.g. "key") remain valid unquoted-looking
// SQL. Safe because the name has already passed IDENTIFIER_RE, which admits
// no backtick or other special character.
function q(name) { return "`" + name + "`"; }
function assertColumn(table, column) {
  const col = assertIdentifier(column, "column");
  const def = TABLES[table];
  if (!def || !Object.prototype.hasOwnProperty.call(def.columns, col)) {
    throw new Error(`[mysqlClient] Unknown column "${col}" for table "${table}"`);
  }
  return q(col);
}
function parseSelectColumns(table, cols) {
  if (!cols || String(cols).trim() === "*") return "*";
  return String(cols).split(",").map(part => {
    const raw = part.trim();
    if (raw === "*") return raw;
    // Relationship embeds are resolved in JS after the base query.
    const embed = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([^)]+)\)$/);
    if (embed) {
      assertIdentifier(embed[1], "relation");
      return raw;
    }
    return assertColumn(table, raw);
  }).join(", ");
}

// ------------------------------------------------------------
// Table definitions: column -> value type, for (de)serialization
// and CREATE TABLE DDL.
// ------------------------------------------------------------

const TABLES = {
  organization_cloud_projects: {
    pk: "id",
    columns: {
      id: "text", organization_id: "text", organization_name: "text", provider: "text", purpose: "text",
      mode: "text", project_id: "text", project_number: "text", billing_account: "text", location: "text",
      credentials_encrypted: "text", status: "text", error_code: "text", error_message: "text", attempt: "int",
      provisioned_at: "text", retained_at: "text", created_at: "text", updated_at: "text"
    }
  },
  organizations: {
    pk: "id",
    uniqueKeys: [["name"], ["workspace_name"]],
    columns: {
      id: "text", name: "text", workspace_name: "text", industry: "text",
      subscription_plan: "text", ai_minutes_used: "real", ai_minutes_limit: "int",
      phone_charges: "real", billing_period_end: "text", billing_method: "text", charge_scope: "text",
      recharge_balance_inr: "real", recharge_reserved_inr: "real", settings: "json",
      feature_flags: "array", status: "text", created_at: "text"
    }
  },
  recharge_billing_reservations: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", provider: "text", estimated_amount_inr: "real",
      actual_amount_inr: "real", duration_seconds: "real", status: "text",
      provider_call_sid: "text", created_at: "text", updated_at: "text",
      released_at: "text", finalized_at: "text"
    }
  },
  recharge_billing_transactions: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", type: "text", amount_inr: "real",
      balance_before_inr: "real", balance_after_inr: "real", metadata: "json",
      created_at: "text"
    }
  },
  org_members: {
    pk: "id",
    // Email is globally unique because one auth identity maps to one customer org.
    // user_id is also unique when present; MySQL permits multiple NULLs, so
    // pre-auth membership rows remain supported. This prevents one auth user
    // from becoming ambiguous across multiple organizations.
    uniqueKeys: [["email"], ["user_id"]],
    columns: {
      id: "text", org_id: "text", user_id: "text", name: "text", email: "text", phone: "text",
      role: "text", status: "text", performance_score: "int",
      assigned_leads_count: "int", feature_flags: "array", created_at: "text"
    }
  },
  leads: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", name: "text", phone: "text", email: "text", gender: "text",
      amount_requested: "real", score: "int", source: "text", status: "text",
      tags: "array", notes: "text", financial_info: "json", group_ids: "array",
      // Universal contact -> campaign -> lead -> opportunity -> client
      // progression (see src/seed/industryPacks.js's getPipelineStageLabels
      // for the industry-worded display labels). Advanced automatically at
      // three points: replaceDialerTasks (contact->campaign, the moment a
      // contact is first added to any dialer task's lead list),
      // callFinalizer.js (campaign/contact->lead, the moment a call to
      // this contact is actually answered/engaged), and PATCH /api/leads/:id
      // (->opportunity when status is set to Qualified, ->client when set
      // to Converted — the two stages that need a human qualification
      // decision, not an automatic signal). NULL/missing reads as "contact"
      // — the default starting stage — so no backfill was needed for rows
      // that existed before this column did.
      pipeline_stage: "text",
      // Preferred time for a human advisor/team member to speak with this
      // contact — captured from the live questionnaire, not the AI redial
      // queue (see call_logs.callback_time / Scheduled Callbacks).
      callback_time: "text",
      created_at: "text", updated_at: "text"
    }
  },
  contact_groups: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", name: "text", created_at: "text"
    }
  },
  workflows: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", name: "text", active: "bool",
      nodes: "json", edges: "json", created_at: "text", updated_at: "text"
    }
  },
  campaigns: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", name: "text", status: "text", workflow_id: "text",
      total_leads: "int", called_leads: "int", successful_calls: "int",
      created_at: "text", updated_at: "text"
    }
  },
  loans: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", lead_id: "text", lead_name: "text", amount: "real",
      interest_rate: "real", term_months: "int", status: "text", monthly_emi: "real",
      paid_emi_count: "int", total_emi_count: "int", next_payment_date: "text",
      documents: "json", history: "json", created_at: "text", updated_at: "text"
    }
  },
  call_logs: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", lead_id: "text", lead_name: "text", campaign_id: "text",
      // Was missing from this columns map entirely — the insert/update
      // path below silently drops any field not listed here (`c in
      // def.columns`), so every write of the caller's actual number to
      // this table was a silent no-op; every read fell back to lead_name
      // instead (see db.getRetryStatusForOrg's `row.caller_number ||
      // row.lead_name`, which was ALWAYS taking the lead_name branch).
      caller_number: "text",
      duration: "int", status: "text", sentiment: "text", intent: "text",
      transcript: "json", summary: "text", recording_url: "text", direction: "text",
      // Auto-redial tracking for "No Answer"/"Answering Machine" outbound
      // calls — see services/dialerRetryEngine.js. attempt_number starts at
      // 1 on the first dial; retry_status is "pending" while a retry is
      // still scheduled, "exhausted" once max attempts are hit, or null for
      // calls that were never eligible for retry (answered normally).
      attempt_number: "int", next_retry_at: "text", retry_status: "text",
      // The exact per-task questions/language/assigned-contact this call
      // was dialed with — a retry needs to redial with the SAME task
      // config, not the org's generic default questionnaire, otherwise a
      // campaign's custom questions get silently swapped out on redial.
      retry_context: "json",
      // Lease timestamp for durable retry claims. If the scheduler dies after
      // claiming a callback but before dispatching it, a later scheduler can
      // safely reclaim the row after the lease expires.
      retry_claimed_at: "text",
      created_at: "text",
      // The telephony provider's own call id for this call (Vobiz
      // CallUUID / Twilio CallSid / Piopiy call id) — lets autoDialEngine.js
      // recognize "the call it placed for this task/lead just finished" by
      // polling for a call_logs row with this value, with no in-process
      // event needed.
      provider_call_sid: "text",
      callback_time: "text",
      // True only when the callee actually engaged in the call — see
      // callFinalizer.js. False for a pickup with no real talk (hung up
      // immediately, said one irrelevant word, wrong number, etc.),
      // distinct from status (which can still be "Completed").
      call_answered: "bool",
      // One-line reason the caller asked for a callback (extractFollowUp's
      // querySummary) — only ever set alongside status "Callback
      // Scheduled". Powers the Scheduled Callbacks tab.
      callback_reason: "text",
      // Canonical post-call action state. These fields are written by the
      // finalizer so every UI surface can render the same outcome without
      // re-interpreting status/retry/callback/enquiry independently.
      conversation_outcome: "text", callback_status: "text", enquiry_status: "text"
    }
  },
  dialer_tasks: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", name: "text", questions: "json", lead_ids: "json",
      status: "text", call_results: "json", starhealth_enabled: "bool",
      created_at: "text", updated_at: "text",
      // Per-call config that previously only ever reached a call via the
      // frontend's per-dial request body — a server-driven auto-dial loop
      // has no request to read these from, so they live on the task row.
      language: "text", assigned_team_member_id: "text",
      // Server-owned auto-dial runtime state, driven by
      // src/crm/autoDialEngine.js and preserved across a frontend sync by
      // db.replaceDialerTasks (see repository.js) — POST/PATCH
      // /api/dialer-tasks/:id/auto-dial/start|stop are the only writers.
      auto_dial_enabled: "bool", auto_dial_status: "text",
      current_lead_id: "text", current_provider_call_sid: "text",
      current_call_started_at: "text", current_provider: "text",
      next_dial_at: "text", auto_dial_started_at: "text",
      outbound_number: "text",
      // Which workflow this task's questions came from — was never
      // persisted at all (no column, no ENTITIES.dialertasks field
      // mapping), only ever living in the frontend's in-memory task
      // object. Fine for the same uninterrupted session the task was
      // created in, but lost on every reload or in any other
      // session/tab, which is why "Extracted Campaign Answers" could
      // resolve a call's answer names/types correctly one moment and
      // fall back to a slugified guess (or the raw question) the next —
      // GET /api/calls/:id/lead-responses needs this to re-resolve
      // names/types from the workflow's CURRENT variables.
      workflow_id: "text",
      // Campaign-level retry policy for unanswered calls. Stored directly
      // on the task so server-side auto-dial and retry workers remain
      // independent of the browser.
      retry_config: "json",
      // Immutable metadata identifying the workflow run that created this
      // dialing task. The same workflow can be launched many times.
      workflow_run_metadata: "json"
    }
  },
  inbound_call_logs: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", caller_name: "text", caller_phone: "text",
      virtual_number: "text", duration: "int", status: "text", sentiment: "text",
      intent: "text", topic: "text", transcript: "json", summary: "text", created_at: "text"
    }
  },
  virtual_numbers: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", number: "text", provider: "text", status: "text",
      friendly_name: "text", routing_url: "text", incoming_call_count: "int",
      outgoing_call_count: "int", agent_id: "text", created_at: "text"
    }
  },
  org_agents: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", name: "text", system_prompt: "text",
      active_voice: "text", emotion: "int", speed: "int", friendliness: "int",
      language: "text", phone_number_id: "text", outbound_number_id: "text",
      active: "bool", knowledge_base_mode: "text", knowledge_base_document_ids: "array",
      // Scalable inbound/outbound prompt system (see config/promptTemplates.js)
      industry: "text", dialect: "text", business_context: "text", call_type: "text",
      created_at: "text", updated_at: "text"
    }
  },
  // Permanent cost/billing snapshot taken right before an org is deleted
  // (platform/admin.js's deleteOrganization) — never written to by, or
  // deleted alongside, the org itself. See migrations/add_org_cost_archive.sql
  // for compatibility with existing application data shapes.
  org_cost_archive: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", org_name: "text", workspace_name: "text", industry: "text",
      org_created_at: "text", deleted_at: "text", deleted_by_email: "text",
      billing_period_end: "text",
      ai_minutes_used: "real", cost_per_minute_inr: "real", ai_minutes_cost_inr: "real",
      phone_charges: "real", phone_cost_per_minute: "real",
      call_provider_key: "text", call_provider_label: "text",
      ai_total_tokens: "int", ai_input_tokens: "int", ai_output_tokens: "int",
      ai_call_count: "int", ai_session_count: "int",
      ai_token_provider_key: "text", ai_token_provider_label: "text",
      ai_token_rate_per_1k: "real", ai_token_unit: "int", ai_token_tax_percent: "real",
      ai_token_base_cost_inr: "real", ai_token_tax_amount_inr: "real", ai_token_total_cost_inr: "real",
      snapshot: "json", created_at: "text"
    }
  },
  question_flows: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", name: "text", description: "text",
      variables: "json", active: "bool",
      created_at: "text", updated_at: "text"
    }
  },
  calls: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", caller_number: "text", agent_name: "text",
      language: "text", duration_seconds: "int", sentiment: "text", transcript: "text",
      recording_url: "text", created_at: "text", summary: "text", next_action: "text",
      analyzed_at: "text"
    }
  },
  lead_responses: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", call_id: "text", policyholder_phone: "text",
      question: "text", answer: "text", label: "text", created_at: "text"
    }
  },
  enquiries: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", call_id: "text", name: "text", phone: "text",
      email: "text", location: "text", query_text: "text",
      assigned_team_member_id: "text", status: "text", created_at: "text"
    }
  },
  customers: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", name: "text", phone: "text", type: "text",
      locality: "text", ltv: "real", khata: "real", created_at: "text"
    }
  },
  catalog_items: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", name: "text", brand: "text", unit: "text",
      price: "real", stock: "int", created_at: "text"
    }
  },
  orders: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", customer: "text", phone: "text", items: "json",
      total: "real", status: "text", source: "text", time: "text", delivery: "text",
      created_at: "text"
    }
  },
  questionnaires: {
    pk: "org_id",
    columns: { org_id: "text", questions: "json", updated_at: "text" }
  },
  objects: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", key: "text", label: "text", icon: "text",
      description: "text", has_pipeline: "bool", position: "int", created_at: "text"
    }
  },
  object_fields: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", object_id: "text", key: "text", label: "text",
      type: "text", options: "json", required: "bool", position: "int", created_at: "text"
    }
  },
  object_stages: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", object_id: "text", key: "text", label: "text",
      color: "text", position: "int", created_at: "text"
    }
  },
  object_records: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", object_id: "text", stage_id: "text", data: "json",
      created_at: "text", updated_at: "text"
    }
  },
  channels: {
    pk: "id",
    uniqueKeys: [["org_id", "type"], ["type", "external_id"]],
    columns: {
      id: "text", org_id: "text", type: "text", external_id: "text", status: "text",
      config: "json", credentials_encrypted: "text", created_at: "text"
    }
  },
  conversations: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", channel_id: "text", channel_type: "text",
      contact_external_id: "text", contact_name: "text", status: "text",
      assigned_to: "text", last_message_at: "text", created_at: "text",
      summary: "text", sentiment: "text", next_action: "text", analyzed_at: "text"
    }
  },
  messages: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", conversation_id: "text", direction: "text",
      sender: "text", body: "text", media_url: "text", message_type: "text",
      external_message_id: "text", created_at: "text"
    }
  },
  workflow_runs: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", workflow_id: "text", lead_id: "text", status: "text",
      log: "json", started_at: "text", completed_at: "text"
    }
  },
  dnc_entries: {
    pk: "id",
    columns: { id: "text", org_id: "text", phone: "text", reason: "text", created_at: "text" }
  },
  knowledge_documents: {
    pk: "id",
    columns: { id: "text", org_id: "text", title: "text", created_at: "text" }
  },
  knowledge_chunks: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", document_id: "text", content: "text",
      chunk_index: "int", created_at: "text"
    }
  },
  audit_log: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", actor_user_id: "text", actor_email: "text",
      action: "text", target_type: "text", target_id: "text", metadata: "json",
      created_at: "text"
    }
  },
  // Local auth backed by the MySQL users table.
  users: {
    pk: "id",
    uniqueKeys: [["email"]],
    columns: { id: "text", email: "text", password_hash: "text", created_at: "text" }
  },
  // Generic key/value store for the super admin panel (pricing, feature
  // flags, etc.) — see services/platformSettings.js.
  platform_settings: {
    pk: "key",
    columns: { key: "text", value: "json", updated_at: "text" }
  },
  // Per-Gemini-Live-session usage/cost tracking — see
  // src/ai/geminiUsageTracker.js. One row per Gemini Live session (a call
  // that reconnects after a mid-call Gemini-side error gets a NEW row for
  // the reconnected session, not a second write to the same row — call_id
  // links them back together). Deliberately holds no transcript/audio,
  // only token counts and cost — this table exists for billing/usage
  // reporting, not call content.
  ai_session_usage: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", admin_id: "text", call_id: "text", session_id: "text",
      provider: "text", gcp_project_id: "text", gcp_location: "text", model: "text",
      session_started_at: "text", session_ended_at: "text", duration_seconds: "real",
      input_tokens: "int", output_tokens: "int", total_tokens: "int",
      input_cost: "real", output_cost: "real", total_cost: "real",
      currency: "text", pricing_version: "text",
      // 'in_progress' | 'completed' | 'failed' — see geminiUsageTracker.js.
      // A row stuck on 'in_progress' with no session_ended_at past some
      // age is exactly how an app crash / unexpected disconnect is
      // detected later (requirement: "do not silently lose usage
      // information that was already received") — the row itself, with
      // whatever partial token counts it had at last update, IS that
      // record; nothing extra needed to find it.
      status: "text", error_code: "text", error_message: "text",
      // Preserves any additional usage/session fields the SDK returns
      // that don't have their own column yet, rather than discarding them.
      metadata: "json",
      // Reserved for a future Google Cloud Billing reconciliation job —
      // not populated or read by anything yet. Present now so adding
      // reconciliation later is an UPDATE to existing rows, not a
      // migration that has to backfill a new table.
      actual_billed_cost: "real", billing_export_id: "text", billing_period: "text",
      reconciliation_status: "text", reconciled_at: "text",
      // Platform-set (super admin Cost page) INR cost, locked in at
      // finalize time using whatever "gemini" AI-provider rate was active
      // THEN — see geminiUsageTracker.js's finalizeUsageSession. Kept
      // separate from input_cost/output_cost/total_cost above (Google's
      // own USD model pricing, geminiPricing.js) so a later rate change
      // on the Cost page never retroactively re-prices a session that
      // already happened; billing reads sum these stored columns instead
      // of recomputing tokens x the current rate.
      platform_cost_provider_key: "text", platform_pricing_mode: "text", platform_rate_per_1k: "real", platform_token_unit: "int", platform_time_rate_amount: "real", platform_time_unit: "text", platform_tax_percent: "real",
      platform_base_cost_inr: "real", platform_tax_amount_inr: "real", platform_total_cost_inr: "real",
      created_at: "text", updated_at: "text"
    }
  },
  call_billing_records: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", call_id: "text", duration_seconds: "real",
      billing_method: "text", pricing_mode: "text",
      voice_agent_cost_inr: "real", post_call_agent_cost_inr: "real", ai_cost_inr: "real",
      telephony_provider: "text", provider_pricing_version: "text",
      provider_rate_amount: "real", provider_rate_unit: "text", provider_cost_inr: "real",
      phone_number_cost_inr: "real", total_cost_inr: "real",
      snapshot: "json", created_at: "text"
    }
  },
  billing_ledger_entries: {
    pk: "id",
    columns: {
      id: "text", org_id: "text", type: "text", amount_inr: "real", balance_after_inr: "real",
      reference_type: "text", reference_id: "text", description: "text", metadata: "json",
      actor_user_id: "text", actor_email: "text", created_at: "text"
    }
  }
};

// Forward embeds: `<table>.<fk_col>` references `<relTable>.id`.
const EMBED_FK = {
  organizations: "org_id",
  knowledge_documents: "document_id"
};
// Reverse (has-many) embeds, count-only.
const EMBED_REVERSE_FK = {
  knowledge_chunks: "document_id"
};

// MySQL cannot index LONGTEXT directly. Keep identifiers and frequently
// filtered/unique fields as bounded VARCHAR values; reserve LONGTEXT for
// genuinely unbounded content such as prompts, transcripts and notes.
const VARCHAR_COLUMNS = new Map([
  ["org_id", "VARCHAR(191)"],
  ["user_id", "VARCHAR(191)"],
  ["admin_id", "VARCHAR(191)"],
  ["id", "VARCHAR(191)"],
  ["email", "VARCHAR(255)"],
  ["name", "VARCHAR(255)"],
  ["workspace_name", "VARCHAR(255)"],
  ["type", "VARCHAR(100)"],
  ["status", "VARCHAR(100)"],
  ["role", "VARCHAR(100)"],
  ["provider", "VARCHAR(100)"],
  ["external_id", "VARCHAR(255)"],
  ["phone", "VARCHAR(64)"],
  ["caller_number", "VARCHAR(64)"],
  ["caller_phone", "VARCHAR(64)"],
  ["virtual_number", "VARCHAR(64)"],
  ["number", "VARCHAR(64)"],
  ["key", "VARCHAR(255)"],
  ["label", "VARCHAR(255)"],
  ["code", "VARCHAR(100)"],
  ["direction", "VARCHAR(32)"],
  ["industry", "VARCHAR(100)"],
  ["dialect", "VARCHAR(100)"],
  ["language", "VARCHAR(100)"],
  ["call_type", "VARCHAR(100)"],
  ["retry_status", "VARCHAR(64)"],
  ["reconciliation_status", "VARCHAR(64)"],
  ["billing_period", "VARCHAR(64)"],
  ["billing_export_id", "VARCHAR(255)"],
  ["workflow_id", "VARCHAR(191)"],
  ["lead_id", "VARCHAR(191)"],
  ["campaign_id", "VARCHAR(191)"],
  ["agent_id", "VARCHAR(191)"],
  ["document_id", "VARCHAR(191)"],
  ["call_id", "VARCHAR(191)"],
  ["session_id", "VARCHAR(191)"],
  ["channel_id", "VARCHAR(191)"],
  ["object_id", "VARCHAR(191)"],
  ["field_id", "VARCHAR(191)"],
  ["phone_number_id", "VARCHAR(191)"],
  ["outbound_number_id", "VARCHAR(191)"],
  ["assigned_team_member_id", "VARCHAR(191)"],
  ["current_lead_id", "VARCHAR(191)"],
  ["current_provider_call_sid", "VARCHAR(255)"],
  ["provider_call_sid", "VARCHAR(255)"],
  ["billing_method", "VARCHAR(32)"],
  ["charge_scope", "VARCHAR(64)"],
  // Indexed columns: MySQL cannot put a BLOB/TEXT column in a key without a
  // prefix length, so every column referenced by a CREATE INDEX below must
  // resolve to a bounded type instead of the LONGTEXT default.
  ["created_at", "VARCHAR(64)"],
  ["next_retry_at", "VARCHAR(64)"],
  ["retry_claimed_at", "VARCHAR(64)"],
  ["next_dial_at", "VARCHAR(64)"],
  ["last_message_at", "VARCHAR(64)"],
  ["conversation_id", "VARCHAR(191)"],
  ["stage_id", "VARCHAR(191)"],
  ["started_at", "VARCHAR(64)"],
]);

function sqlType(t, col = "", isPk = false) {
  if (t === "int") return "INT";
  if (t === "bool") return "BOOLEAN";
  if (t === "real") return "DOUBLE";
  if (t === "json") return "JSON";
  if (t === "array") return "JSON";
  if (isPk) return "VARCHAR(191)";
  return VARCHAR_COLUMNS.get(col) || "LONGTEXT";
}

function isExpectedAlreadyExistsError(err) {
  // MySQL error codes for idempotent schema operations.
  return [
    "ER_DUP_FIELDNAME", // ALTER TABLE ... ADD COLUMN when the column exists
    "ER_DUP_KEYNAME",   // CREATE INDEX when the index name exists
  ].includes(err?.code);
}

// app and scheduler are separate processes/containers that both require
// this module independently — without coordination, both would run the
// CREATE TABLE/ALTER TABLE/CREATE INDEX/ADD CONSTRAINT/feature-flag-UPDATE
// sequence below concurrently on separate connections, which produced a
// real "Deadlock found when trying to get lock" in production (MDL
// contention on ADD CONSTRAINT FOREIGN KEY, since nearly every tenant
// table's FK references `organizations`, plus row locks from the
// feature-flag UPDATEs). MySQL's GET_LOCK()/RELEASE_LOCK() is an
// advisory lock scoped to the single connection that acquired it — it is
// NOT tied to a transaction and is NOT released by COMMIT, only by
// RELEASE_LOCK(), the connection closing, or the session ending. That
// means GET_LOCK, every statement in the body below, and RELEASE_LOCK
// must all run on the exact same connection object (`client`), which is
// why the lock is acquired and released here rather than via a separate
// pool.query() call.
const SCHEMA_MIGRATION_LOCK_NAME = "chiefvoice_schema_migration";
const SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS = 60;

async function createTables() {
  const client = await pool.connect();
  try {
    const lockResult = await client.query(
      `SELECT GET_LOCK(?, ?) AS acquired`,
      [SCHEMA_MIGRATION_LOCK_NAME, SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS]
    );
    // GET_LOCK returns 1 on success, 0 on timeout, NULL on error (e.g. the
    // session was killed while waiting). Only 1 means this connection may
    // safely proceed; anything else must abort rather than race whichever
    // process still holds — or almost holds — the lock.
    if (lockResult.rows?.[0]?.acquired !== 1) {
      throw new Error(
        `[mysqlClient] could not acquire schema migration lock "${SCHEMA_MIGRATION_LOCK_NAME}" within ${SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS}s — another process may be stuck holding it`
      );
    }
    try {
      await runSchemaMigration(client);
    } finally {
      // Always attempt release, including when runSchemaMigration threw —
      // an unreleased advisory lock would otherwise wedge every future
      // boot (app and scheduler alike) until this connection's session
      // ends. A failure to release is logged, not thrown, so the
      // original migration error (if any) is what callers see.
      try {
        await client.query(`SELECT RELEASE_LOCK(?)`, [SCHEMA_MIGRATION_LOCK_NAME]);
      } catch (releaseErr) {
        log.error(`[mysqlClient] failed to release schema migration lock: ${releaseErr.message}`);
      }
    }
  } finally { client.release(); }
}

async function runSchemaMigration(client) {
    for (const [table, def] of Object.entries(TABLES)) {
      const cols = Object.entries(def.columns)
        .map(([col, type]) => `${q(col)} ${sqlType(type, col, col === def.pk)}${col === def.pk ? " PRIMARY KEY" : ""}`)
        .join(", ");
      await client.query(`CREATE TABLE IF NOT EXISTS ${table} (${cols})`);
      for (const [col, type] of Object.entries(def.columns)) {
        try { await client.query(`ALTER TABLE ${table} ADD COLUMN ${q(col)} ${sqlType(type, col, col === def.pk)}`); } catch (err) {
          // The column may already exist. Ignore only that expected case;
          // surface real schema errors so startup cannot silently continue
          // with a partially migrated database.
          if (err?.code !== "ER_DUP_FIELDNAME") throw err;
        }
      }
      // Normalize every declared column to the current MySQL type, not just
      // bounded VARCHAR columns. This repairs databases created by an older
      // adapter version (for example TEXT -> LONGTEXT or LONGTEXT -> JSON)
      // instead of merely adding missing columns. MySQL validates/converts
      // existing values during MODIFY; invalid JSON or overflowing VARCHAR
      // data therefore fails loudly rather than being silently corrupted.
      for (const [col, declaredType] of Object.entries(def.columns)) {
        try {
          const type = sqlType(declaredType, col, col === def.pk);
          await client.query(`ALTER TABLE ${table} MODIFY COLUMN ${q(col)} ${type}${col === def.pk ? " PRIMARY KEY" : ""}`);
        } catch (err) {
          // ER_MULTIPLE_PRI_KEY: the column is already the table's primary
          // key from a previous run — re-declaring it via MODIFY COLUMN is
          // redundant, not a real schema conflict, so it's safe to ignore.
          if (err?.code !== "ER_DUP_FIELDNAME" && err?.code !== "ER_NO_SUCH_TABLE" && err?.code !== "ER_MULTIPLE_PRI_KEY") throw err;
        }
      }
      if (def.columns.org_id) {
        try { await client.query(`CREATE INDEX idx_${table}_org_id ON ${table} (org_id)`); } catch (err) {
          if (!isExpectedAlreadyExistsError(err)) throw err;
        }
      }
    }
    for (const col of ["call_id", "session_id", "admin_id", "created_at"]) {
      try {
        await client.query(`CREATE INDEX idx_ai_session_usage_${col} ON ai_session_usage (${col})`);
      } catch (err) {
        if (!isExpectedAlreadyExistsError(err)) throw err;
      }
    }
    try { await client.query(`CREATE UNIQUE INDEX idx_channels_org_type ON channels (org_id, type)`); } catch (err) {
      if (!isExpectedAlreadyExistsError(err)) throw err;
    }
    try { await client.query(`CREATE UNIQUE INDEX idx_channels_type_external_id ON channels (type, external_id)`); } catch (err) {
      if (!isExpectedAlreadyExistsError(err)) throw err;
    }
    // Case-insensitive uniqueness is provided by the default utf8mb4 collation.
    // These columns are bounded VARCHAR values, so no LONGTEXT prefix index is needed.
    // Query-driven indexes. These are intentionally narrow and cover the
    // high-frequency tenant, polling, retry, conversation and knowledge-base
    // lookups without creating an index for every column. Index creation is
    // idempotent by name; unexpected failures still abort startup.
    // An auth identity must map to at most one customer organization.
    // Detect legacy duplicate user_id values before creating the unique index
    // so operators get a useful migration error instead of a generic 1062.
    try {
      const duplicates = await client.query(`
        SELECT user_id, COUNT(*) AS member_count
        FROM org_members
        WHERE user_id IS NOT NULL
        GROUP BY user_id
        HAVING COUNT(*) > 1
        LIMIT 10
      `);
      if (duplicates.rows.length) {
        const ids = duplicates.rows.map((r) => `${r.user_id} (${r.member_count})`).join(", ");
        throw new Error(`[mysqlClient] org_members contains duplicate user_id values; resolve before startup: ${ids}`);
      }
    } catch (err) {
      if (err?.message?.startsWith("[mysqlClient] org_members contains duplicate")) throw err;
      throw new Error(`[mysqlClient] failed to validate org_members.user_id uniqueness: ${err.message}`, { cause: err });
    }

    for (const [name, table, cols] of [
      ["idx_users_email", "users", ["email"]],
      ["idx_organizations_name", "organizations", ["name"]],
      ["idx_organizations_workspace", "organizations", ["workspace_name"]],
      ["idx_org_members_email", "org_members", ["email"]],
      ["idx_org_members_user_id", "org_members", ["user_id"]],
      ["idx_virtual_numbers_org_number", "virtual_numbers", ["org_id", "number"]],
      ["idx_leads_org_phone", "leads", ["org_id", "phone"]],
      ["idx_leads_org_status", "leads", ["org_id", "status"]],
      ["idx_call_logs_org_created", "call_logs", ["org_id", "created_at"]],
      ["idx_call_logs_org_retry_due", "call_logs", ["org_id", "retry_status", "next_retry_at"]],
      ["idx_call_logs_org_status_retry_due", "call_logs", ["org_id", "status", "retry_status", "next_retry_at"]],
      ["idx_call_logs_retry_claim_lease", "call_logs", ["retry_status", "retry_claimed_at"]],
      ["idx_call_logs_provider_sid", "call_logs", ["provider_call_sid"]],
      ["idx_dialer_tasks_org_due", "dialer_tasks", ["org_id", "auto_dial_enabled", "next_dial_at"]],
      ["idx_dialer_tasks_provider_sid", "dialer_tasks", ["current_provider_call_sid"]],
      ["idx_org_agents_org_active", "org_agents", ["org_id", "active"]],
      ["idx_inbound_call_logs_org_created", "inbound_call_logs", ["org_id", "created_at"]],
      ["idx_calls_org_created", "calls", ["org_id", "created_at"]],
      ["idx_lead_responses_org_call_created", "lead_responses", ["org_id", "call_id", "created_at"]],
      ["idx_enquiries_org_status_created", "enquiries", ["org_id", "status", "created_at"]],
      ["idx_messages_conversation_created", "messages", ["conversation_id", "created_at"]],
      ["idx_conversations_org_last_message", "conversations", ["org_id", "last_message_at"]],
      ["idx_workflow_runs_org_status_created", "workflow_runs", ["org_id", "status", "started_at"]],
      ["idx_knowledge_documents_org_created", "knowledge_documents", ["org_id", "created_at"]],
      ["idx_knowledge_chunks_document_index", "knowledge_chunks", ["document_id", "chunk_index"]],
      ["idx_dnc_entries_org_phone", "dnc_entries", ["org_id", "phone"]],
      ["idx_object_fields_org_object_position", "object_fields", ["org_id", "object_id", "position"]],
      ["idx_object_stages_org_object_position", "object_stages", ["org_id", "object_id", "position"]],
      ["idx_object_records_org_object_stage_created", "object_records", ["org_id", "object_id", "stage_id", "created_at"]],
      ["idx_audit_log_org_created", "audit_log", ["org_id", "created_at"]],
      ["idx_ai_session_usage_org_created", "ai_session_usage", ["org_id", "created_at"]],
      ["idx_org_cost_archive_org_id", "org_cost_archive", ["org_id"]]
    ]) {
      try {
        await client.query(`CREATE ${table === "users" || table === "organizations" || table === "org_members" || name === "idx_org_cost_archive_org_id" ? "UNIQUE " : ""}INDEX ${name} ON ${table} (${cols.join(", ")})`);
      } catch (err) {
        if (!isExpectedAlreadyExistsError(err)) throw err;
      }
    }
    // Referential integrity: every tenant-owned table must point at a real
    // organization. We intentionally enforce the tenant boundary at the DB
    // level, not just in application code. Existing orphan rows are rejected
    // before the FK is created so a migration can never silently discard data.
    const tenantTables = Object.entries(TABLES)
      .filter(([table, def]) => table !== "organizations" && table !== "org_cost_archive" && def.columns.org_id)
      .map(([table]) => table);

    for (const table of tenantTables) {
      const orphanResult = await client.query(
        `SELECT COUNT(*) AS orphan_count
           FROM \`${table}\` t
           LEFT JOIN organizations o ON o.id = t.org_id
          WHERE t.org_id IS NOT NULL AND o.id IS NULL`
      );
      const orphanCount = Number(orphanResult.rows?.[0]?.orphan_count || 0);
      if (orphanCount > 0) {
        throw new Error(`[mysqlClient] referential-integrity check failed: ${table}.org_id contains ${orphanCount} orphan row(s); repair them before startup`);
      }

      const fkResult = await client.query(
        `SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND COLUMN_NAME = 'org_id'
            AND REFERENCED_TABLE_NAME IS NOT NULL` ,
        [table]
      );
      const validFk = (fkResult.rows || []).some((r) =>
        r.REFERENCED_TABLE_NAME === "organizations" && r.REFERENCED_COLUMN_NAME === "id"
      );
      if (!validFk) {
        const constraint = assertIdentifier(`fk_${table}_org`, "foreign-key constraint");
        await client.query(
          `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` FOREIGN KEY (org_id) REFERENCES organizations(id) ON UPDATE CASCADE ON DELETE CASCADE`
        );
      }
    }

    for (const flagKey of ["leads", "pipeline"]) {
      try {
        await client.query(`UPDATE organizations SET feature_flags = JSON_ARRAY_APPEND(COALESCE(feature_flags, JSON_ARRAY()), '$', ?) WHERE JSON_CONTAINS(COALESCE(feature_flags, JSON_ARRAY()), JSON_QUOTE(?)) = 0`, [flagKey, flagKey]);
        await client.query(`UPDATE org_members SET feature_flags = JSON_ARRAY_APPEND(COALESCE(feature_flags, JSON_ARRAY()), '$', ?) WHERE JSON_CONTAINS(COALESCE(feature_flags, JSON_ARRAY()), JSON_QUOTE(?)) = 0`, [flagKey, flagKey]);
      } catch (err) {
        // Backfill is part of schema initialization. A failed write here can
        // leave tenants with an inconsistent feature-flag shape, so fail
        // startup instead of merely logging and continuing.
        throw new Error(`[mysqlClient] feature flag backfill failed for "${flagKey}": ${err.message}`, { cause: err });
      }
    }
}
const ready = createTables().catch((err) => {
  log.error("[mysqlClient] failed to initialize schema:", err.message);
  throw err;
});

function genId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function serializeJsonValue(type, value) {
  if (type === "array" && !Array.isArray(value)) {
    throw new TypeError("[mysqlClient] JSON array column requires an array value");
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    throw new TypeError(`[mysqlClient] Unable to serialize JSON value: ${err.message}`, { cause: err });
  }
}

function serializeValue(type, value) {
  if (value === undefined || value === null) return null;
  if (type === "json" || type === "array") return serializeJsonValue(type, value);
  return value;
}

function deserializeValue(type, value) {
  if (value === null || value === undefined) return value;
  if (type !== "json" && type !== "array") return value;
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    if (type === "array" && !Array.isArray(parsed)) {
      throw new TypeError("stored JSON value is not an array");
    }
    return parsed;
  } catch (err) {
    throw new Error(`[mysqlClient] Invalid JSON in ${type} column: ${err.message}`, { cause: err });
  }
}

function deserializeRow(table, row) {
  if (!row) return row;
  const def = TABLES[table];
  const out = {};
  for (const [col, type] of Object.entries(def.columns)) {
    out[col] = deserializeValue(type, row[col]);
  }
  return out;
}

// ------------------------------------------------------------
// Query builder — preserves the existing chainable application surface
// ------------------------------------------------------------

class QueryBuilder {
  constructor(table) {
    this.table = table;
    this.def = TABLES[table];
    if (!this.def) throw new Error(`[mysqlClient] unknown table "${table}"`);
    this.op = null;
    this.payload = null;
    this.filters = [];
    this.selectOpts = {};
    this.selectCols = "*";
    this.wantSelect = false;
    this.orderCol = null;
    this.orderAsc = true;
    this.limitN = null;
    this.rangeFrom = null;
    this.rangeTo = null;
    this.searchCol = null;
    this.searchQuery = null;
  }

  select(cols = "*", opts = {}) {
    this.selectCols = parseSelectColumns(this.table, cols);
    this.selectOpts = opts;
    this.wantSelect = true;
    if (!this.op) this.op = "select";
    return this;
  }

  eq(col, val)    { this.filters.push(["eq", assertColumn(this.table, col), val]); return this; }
  neq(col, val)   { this.filters.push(["neq", assertColumn(this.table, col), val]); return this; }
  is(col, val)    { this.filters.push(["is", assertColumn(this.table, col), val]); return this; }
  in(col, arr)    { this.filters.push(["in", assertColumn(this.table, col), arr]); return this; }
  gt(col, val)    { this.filters.push(["gt", assertColumn(this.table, col), val]); return this; }
  gte(col, val)   { this.filters.push(["gte", assertColumn(this.table, col), val]); return this; }
  lte(col, val)   { this.filters.push(["lte", assertColumn(this.table, col), val]); return this; }
  ilike(col, val) { this.filters.push(["ilike", assertColumn(this.table, col), val]); return this; }
  match(obj = {}) { for (const [col, val] of Object.entries(obj)) this.eq(col, val); return this; }
  not(col, operator, val) { this.filters.push(["not", assertColumn(this.table, col), operator, val]); return this; }
  filter(col, operator, val) { this.filters.push(["filter", assertColumn(this.table, col), operator, val]); return this; }
  or(expression) { this.filters.push(["or", expression]); return this; }

  order(col, { ascending = true } = {}) { this.orderCol = assertColumn(this.table, col); this.orderAsc = Boolean(ascending); return this; }
  limit(n) { this.limitN = Number(n); if (!Number.isInteger(this.limitN) || this.limitN < 0) throw new Error("[mysqlClient] Invalid LIMIT"); return this; }
  // Page-by-offset primitive — 0-indexed, inclusive on both
  // ends (range(0, 24) = rows 1-25). Was entirely missing from this shim:
  // every paginated read in the codebase (db.list's { page, limit } path
  // in repository.js, auditLog.js's list()) called this unconditionally
  // whenever pagination was requested, throwing "query.range is not a
  // function" — silently swallowed by both callers into an empty
  // result/500, which is why the Enquiries and Audit Log pages showed
  // nothing despite real rows existing.
  range(from, to) { this.rangeFrom = from; this.rangeTo = to; return this; }

  textSearch(col, query) { this.searchCol = assertColumn(this.table, col); this.searchQuery = query; return this; }

  insert(rows) { this.op = "insert"; this.payload = rows; return this; }
  update(row) { this.op = "update"; this.payload = row; return this; }
  upsert(row) { this.op = "upsert"; this.payload = row; return this; }
  delete() { this.op = "delete"; return this; }

  single() { return this._exec({ single: true }); }
  maybeSingle() { return this._exec({ maybeSingle: true }); }

  then(resolve, reject) { return this._exec({}).then(resolve, reject); }
  catch(onReject) { return this._exec({}).catch(onReject); }

  _buildWhere(startIdx = 1) {
    const clauses = []; const params = [];
    for (const [kind, col, val, extra] of this.filters) {
      if (kind === "eq") { clauses.push(`${col} = ?`); params.push(val); }
      else if (kind === "neq") { clauses.push(`${col} != ?`); params.push(val); }
      else if (kind === "is") clauses.push(val === null || String(val).toLowerCase() === "null" ? `${col} IS NULL` : `${col} IS NOT NULL`);
      else if (kind === "gt") { clauses.push(`${col} > ?`); params.push(val); }
      else if (kind === "gte") { clauses.push(`${col} >= ?`); params.push(val); }
      else if (kind === "lte") { clauses.push(`${col} <= ?`); params.push(val); }
      else if (kind === "ilike") { clauses.push(`${col} LIKE ?`); params.push(val); }
      else if (kind === "in") { if (!val || !val.length) clauses.push("0"); else { clauses.push(`${col} IN (${val.map(() => "?").join(",")})`); params.push(...val); } }
      else if (kind === "not") {
        const operator = String(val || "eq").toLowerCase();
        const value = extra;
        if (operator === "is") clauses.push(value === null || String(value).toLowerCase() === "null" ? `${col} IS NOT NULL` : `${col} IS NULL`);
        else if (operator === "eq") { clauses.push(`${col} != ?`); params.push(value); }
        else if (operator === "in") { const vals = Array.isArray(value) ? value : []; if (!vals.length) clauses.push("1"); else { clauses.push(`${col} NOT IN (${vals.map(() => "?").join(",")})`); params.push(...vals); } }
        else throw new Error(`Unsupported .not() operator: ${operator}`);
      }
      else if (kind === "filter") {
        const operator = String(val || "eq").toLowerCase();
        const value = extra;
        if (operator === "eq") { clauses.push(`${col} = ?`); params.push(value); }
        else if (operator === "neq") { clauses.push(`${col} != ?`); params.push(value); }
        else if (operator === "gt") { clauses.push(`${col} > ?`); params.push(value); }
        else if (operator === "gte") { clauses.push(`${col} >= ?`); params.push(value); }
        else if (operator === "lt") { clauses.push(`${col} < ?`); params.push(value); }
        else if (operator === "lte") { clauses.push(`${col} <= ?`); params.push(value); }
        else if (operator === "like" || operator === "ilike") { clauses.push(`${col} LIKE ?`); params.push(value); }
        else if (operator === "is") clauses.push(value === null || String(value).toLowerCase() === "null" ? `${col} IS NULL` : `${col} IS NOT NULL`);
        else throw new Error(`Unsupported .filter() operator: ${operator}`);
      }
      else if (kind === "or") {
        const parts = String(col).split(",").map(part => part.trim()).filter(Boolean).map(part => {
          const [field, operator, ...rawParts] = part.split(".");
          const safeField = assertColumn(this.table, field);
          const raw = rawParts.join(".");
          if (!field || !operator) throw new Error(`Invalid .or() expression: ${part}`);
          if (operator === "eq") { params.push(raw); return `${safeField} = ?`; }
          if (operator === "neq") { params.push(raw); return `${safeField} != ?`; }
          if (operator === "gt") { params.push(raw); return `${safeField} > ?`; }
          if (operator === "gte") { params.push(raw); return `${safeField} >= ?`; }
          if (operator === "lt") { params.push(raw); return `${safeField} < ?`; }
          if (operator === "lte") { params.push(raw); return `${safeField} <= ?`; }
          if (operator === "is") return String(raw).toLowerCase() === "null" ? `${safeField} IS NULL` : `${safeField} IS NOT NULL`;
          if (operator === "like" || operator === "ilike") { params.push(raw); return `${safeField} LIKE ?`; }
          throw new Error(`Unsupported .or() operator: ${operator}`);
        });
        if (parts.length) clauses.push(`(${parts.join(" OR ")})`);
      }
    }
    if (this.searchCol && this.searchQuery) { clauses.push(`content LIKE ?`); params.push(`%${this.searchQuery}%`); }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  async _resolveEmbeds(cols, rows) {
    const embedRe = /([a-zA-Z_]+)\(([^)]+)\)/g;
    let match;
    while ((match = embedRe.exec(cols))) {
      const [, relTable, subcols] = match;
      if (EMBED_FK[relTable]) {
        const fk = relTable === "organizations" ? "org_id" : EMBED_FK[relTable];
        for (const row of rows) {
          const relId = row[fk];
          if (!relId) { row[relTable] = null; continue; }
          const { rows: relRows } = await pool.query(`SELECT * FROM ${relTable} WHERE id = $1`, [relId]);
          row[relTable] = relRows[0] ? deserializeRow(relTable, relRows[0]) : null;
        }
      } else if (EMBED_REVERSE_FK[relTable] && subcols.trim() === "count") {
        const fk = EMBED_REVERSE_FK[relTable];
        for (const row of rows) {
          const { rows: countRows } = await pool.query(`SELECT COUNT(*) as c FROM ${relTable} WHERE ${fk} = $1`, [row.id]);
          row[relTable] = [{ count: Number(countRows[0].c) }];
        }
      }
    }
    return rows;
  }

  async _exec(mode) {
    try {
      await ready;
      return await this._execAsync(mode);
    } catch (err) {
      return { data: null, error: { message: err.message }, count: null };
    }
  }

  async _execAsync(mode) {
    const table = this.table; const def = this.def;
    if (this.op === "delete") { const {where,params}=this._buildWhere(); await pool.query(`DELETE FROM ${table} ${where}`,params); return {data:null,error:null}; }
    if (this.op === "insert") {
      const rows=Array.isArray(this.payload)?this.payload:[this.payload]; const inserted=[];
      for (const apiRow of rows) { const row={...apiRow}; if (!row.id) row.id=genId(); if ("created_at" in def.columns && row.created_at===undefined) row.created_at=nowIso(); if ("updated_at" in def.columns && row.updated_at===undefined) row.updated_at=nowIso();
        const cols=Object.keys(row).filter(c=>c in def.columns); const values=cols.map(c=>serializeValue(def.columns[c],row[c]));
        await pool.query(`INSERT INTO ${table} (${cols.map(q).join(",")}) VALUES (${cols.map(()=>"?").join(",")})`,values);
        const r=await pool.query(`SELECT * FROM ${table} WHERE ${q(def.pk)} = ?`,[row[def.pk]]); inserted.push(deserializeRow(table,r.rows[0]));
      } return this._finishWrite(inserted,mode);
    }
    if (this.op === "update") {
      const patch={...this.payload}; const cols=Object.keys(patch).filter(c=>c in def.columns); const values=cols.map(c=>serializeValue(def.columns[c],patch[c])); const {where,params}=this._buildWhere();
      if(cols.length) await pool.query(`UPDATE ${table} SET ${cols.map(c=>`${q(c)} = ?`).join(",")} ${where}`,[...values,...params]);
      const fresh=await pool.query(`SELECT * FROM ${table} ${where}`,params); return this._finishWrite(fresh.rows.map(r=>deserializeRow(table,r)),mode);
    }
    if (this.op === "upsert") {
      const row={...this.payload};
      if(!row[def.pk]) row[def.pk]=genId();
      const all=Object.keys(row).filter(c=>c in def.columns);
      const cols=all.filter(c=>c!==def.pk);
      const values=all.map(c=>serializeValue(def.columns[c],row[c]));
      // Use MySQL's atomic duplicate-key handling. The previous implementation
      // performed SELECT -> UPDATE/INSERT, which could race under concurrent
      // requests.
      const updateCols=cols.length ? cols : [def.pk];
      const updateSql=updateCols.map(c=>`${q(c)} = VALUES(${q(c)})`).join(",");
      await pool.query(
        `INSERT INTO ${table} (${all.map(q).join(",")}) VALUES (${all.map(()=>"?").join(",")}) ON DUPLICATE KEY UPDATE ${updateSql}`,
        values
      );

      // If the insert collided with a non-PK unique key, the generated PK in
      // `row` belongs to the attempted insert, not the existing record. Find
      // the actual persisted row using a supplied unique key.
      let saved;
      const uniqueKeys=def.uniqueKeys || [[def.pk]];
      for (const keyCols of uniqueKeys) {
        if (!keyCols.every(c => row[c] !== undefined && row[c] !== null)) continue;
        const clauses=keyCols.map(c=>`${q(c)} = ?`).join(" AND ");
        const result=await pool.query(`SELECT * FROM ${table} WHERE ${clauses} LIMIT 1`, keyCols.map(c=>serializeValue(def.columns[c],row[c])));
        if (result.rows[0]) { saved=result.rows[0]; break; }
      }
      if (!saved) {
        const result=await pool.query(`SELECT * FROM ${table} WHERE ${q(def.pk)} = ? LIMIT 1`,[row[def.pk]]);
        saved=result.rows[0];
      }
      if (!saved) throw new Error(`Upsert succeeded but persisted ${table} row could not be located`);
      return this._finishWrite([deserializeRow(table,saved)],mode);
    }
    if(this.selectOpts.count && this.selectOpts.head){ const {where,params}=this._buildWhere(); const r=await pool.query(`SELECT COUNT(*) c FROM ${table} ${where}`,params); return {data:null,error:null,count:Number(r.rows[0].c)}; }
    const {where,params}=this._buildWhere(); let sql=`SELECT * FROM ${table} ${where}`; if(this.orderCol) sql+=` ORDER BY ${this.orderCol} ${this.orderAsc?"ASC":"DESC"}`; if(this.rangeFrom!=null&&this.rangeTo!=null) sql+=` LIMIT ${Number(this.rangeTo-this.rangeFrom+1)} OFFSET ${Number(this.rangeFrom)}`; else if(this.limitN) sql+=` LIMIT ${Number(this.limitN)}`;
    const raw=await pool.query(sql,params); const rows=raw.rows.map(r=>deserializeRow(table,r)); await this._resolveEmbeds(this.selectCols,rows); let totalCount=null; if(this.selectOpts.count==="exact"){const c=await pool.query(`SELECT COUNT(*) c FROM ${table} ${where}`,params); totalCount=Number(c.rows[0].c);} return this._finishRead(rows,mode,totalCount);
  }

  _finishWrite(rows, mode) {
    if (mode.single) return { data: rows[0] || null, error: rows.length ? null : { message: "No row returned" } };
    if (mode.maybeSingle) return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }

  _finishRead(rows, mode, totalCount = null) {
    if (mode.single) return { data: rows[0] || null, error: rows.length ? null : { message: "No rows found" } };
    if (mode.maybeSingle) return { data: rows[0] || null, error: null };
    return { data: rows, error: null, count: totalCount !== null ? totalCount : rows.length };
  }
}

// ------------------------------------------------------------
// Auth surface backed by the MySQL users table + JWT
// ------------------------------------------------------------

const auth = {
  async getUser(token) {
    try {
      const payload = jwt.verify(token, AUTH_SECRET);
      return { data: { user: { id: payload.sub, email: payload.email } }, error: null };
    } catch (err) {
      return { data: null, error: { message: "Invalid or expired session" } };
    }
  },

  async signInWithPassword({ email, password }) {
    await ready;
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [String(email).toLowerCase()]);
    const row = rows[0];
    if (!row) return { data: { session: null }, error: { message: "Invalid login credentials" } };
    const ok = bcrypt.compareSync(password, row.password_hash);
    if (!ok) return { data: { session: null }, error: { message: "Invalid login credentials" } };
    const accessToken = jwt.sign({ sub: row.id, email: row.email }, AUTH_SECRET, { expiresIn: AUTH_TOKEN_TTL });
    return {
      data: {
        user: { id: row.id, email: row.email },
        session: { access_token: accessToken, refresh_token: accessToken }
      },
      error: null
    };
  },

  admin: {
    async createUser({ email, password }) {
      await ready;
      const normalizedEmail = String(email).toLowerCase();
      const { rows: existingRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [normalizedEmail]);
      if (existingRows[0]) return { data: null, error: { message: "User already registered" } };
      const id = genId();
      const passwordHash = bcrypt.hashSync(password, 10);
      await pool.query(
        `INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)`,
        [id, normalizedEmail, passwordHash, nowIso()]
      );
      return { data: { user: { id, email: normalizedEmail } }, error: null };
    },

    async deleteUser(id) {
      if (!id) return { data: null, error: null };
      await ready;
      await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
      return { data: null, error: null };
    },

    async listUsers() {
      await ready;
      const { rows } = await pool.query(`SELECT id, email, created_at FROM users`);
      return {
        data: { users: rows.map((r) => ({ id: r.id, email: r.email, created_at: r.created_at, last_sign_in_at: null })) },
        error: null
      };
    }
  }
};

const client = {
  from(table) { return new QueryBuilder(table); },
  auth,
  ready, // resolves once CREATE TABLE / ALTER TABLE migrations have run
  async close() { await ready; await closePool(); },
  TABLES
};

module.exports = client;
