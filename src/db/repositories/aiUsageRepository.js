// AI usage reporting persistence boundary. Keeps billing/reporting SQL out of
// the legacy monolithic repository while preserving the existing return shape.
const supabase = require("../client");
const { pool } = require("../pool");
const { getRequestAuthority } = require('../../authorization/policy');

const FIELDS = {
  id: "id", orgId: "org_id", adminId: "admin_id", callId: "call_id", sessionId: "session_id", provider: "provider",
  gcpProjectId: "gcp_project_id", gcpLocation: "gcp_location", model: "model", sessionStartedAt: "session_started_at",
  sessionEndedAt: "session_ended_at", durationSeconds: "duration_seconds", inputTokens: "input_tokens", outputTokens: "output_tokens",
  totalTokens: "total_tokens", inputCost: "input_cost", outputCost: "output_cost", totalCost: "total_cost", currency: "currency",
  pricingVersion: "pricing_version", status: "status", errorCode: "error_code", errorMessage: "error_message", metadata: "metadata",
  actualBilledCost: "actual_billed_cost", billingExportId: "billing_export_id", billingPeriod: "billing_period",
  reconciliationStatus: "reconciliation_status", reconciledAt: "reconciled_at", platformCostProviderKey: "platform_cost_provider_key",
  platformRatePer1k: "platform_rate_per_1k", platformTokenUnit: "platform_token_unit", platformTaxPercent: "platform_tax_percent",
  platformBaseCostInr: "platform_base_cost_inr", platformTaxAmountInr: "platform_tax_amount_inr", platformTotalCostInr: "platform_total_cost_inr",
  createdAt: "created_at", updatedAt: "updated_at"
};
function toApi(row) { const out = {}; for (const [a, d] of Object.entries(FIELDS)) out[a] = row?.[d]; return out; }

async function getSession(id, orgId) {
  const { data, error } = await supabase.from("ai_session_usage").select("*").eq("id", id).eq("org_id", orgId).single();
  if (error) return null;
  return toApi(data);
}

async function getSummary(orgId, { fromIso = null, toIso = null } = {}) {
  const scope = getRequestAuthority();
  const clauses = ["org_id = $1", "COALESCE(workspace_id,org_id) = $2"]; const params = [orgId, scope?.workspaceId || orgId]; let i = 3;
  if (fromIso) { clauses.push(`created_at >= $${i++}`); params.push(fromIso); }
  if (toIso) { clauses.push(`created_at <= $${i++}`); params.push(toIso); }
  const { rows } = await pool.query(`SELECT COUNT(*) session_count, COUNT(DISTINCT call_id) call_count,
    COALESCE(SUM(input_tokens),0) total_input_tokens, COALESCE(SUM(output_tokens),0) total_output_tokens,
    COALESCE(SUM(total_tokens),0) total_tokens, COALESCE(SUM(total_cost),0) total_cost,
    COALESCE(SUM(platform_base_cost_inr),0) platform_base_cost_inr, COALESCE(SUM(platform_tax_amount_inr),0) platform_tax_amount_inr,
    COALESCE(SUM(platform_total_cost_inr),0) platform_total_cost_inr,
    SUM(platform_total_cost_inr IS NOT NULL) platform_priced_count,
    SUM(status='failed') failed_count, SUM(status='in_progress') in_progress_count
    FROM ai_session_usage WHERE ${clauses.join(" AND ")}`, params);
  const r = rows[0] || {};
  return {
    sessionCount: Number(r.session_count||0), callCount: Number(r.call_count||0), totalInputTokens: Number(r.total_input_tokens||0),
    totalOutputTokens: Number(r.total_output_tokens||0), totalTokens: Number(r.total_tokens||0), totalCost: Number(r.total_cost||0),
    platformBaseCostInr: Number(r.platform_base_cost_inr||0), platformTaxAmountInr: Number(r.platform_tax_amount_inr||0),
    platformTotalCostInr: Number(r.platform_total_cost_inr||0), platformPricedCount: Number(r.platform_priced_count||0),
    failedCount: Number(r.failed_count||0), inProgressCount: Number(r.in_progress_count||0), currency: "USD"
  };
}

async function getByAdmin(orgId, { fromIso = null, toIso = null } = {}) {
  const scope = getRequestAuthority();
  const clauses = ["org_id = $1", "COALESCE(workspace_id,org_id) = $2"]; const params = [orgId, scope?.workspaceId || orgId]; let i = 3;
  if (fromIso) { clauses.push(`created_at >= $${i++}`); params.push(fromIso); }
  if (toIso) { clauses.push(`created_at <= $${i++}`); params.push(toIso); }
  const { rows } = await pool.query(`SELECT admin_id, COUNT(*) session_count, COALESCE(SUM(total_tokens),0) total_tokens,
    COALESCE(SUM(total_cost),0) total_cost FROM ai_session_usage WHERE ${clauses.join(" AND ")} GROUP BY admin_id ORDER BY total_cost DESC`, params);
  return rows.map(r => ({ adminId: r.admin_id, sessionCount: Number(r.session_count||0), totalTokens: Number(r.total_tokens||0), totalCost: Number(r.total_cost||0) }));
}
module.exports = { getSession, getSummary, getByAdmin };
