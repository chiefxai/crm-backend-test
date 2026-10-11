'use strict';


function rowsOf(result) {
  const value = Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(value) ? value : value?.rows || [];
}

function parseSettings(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function classify(row) {
  const settings = parseSettings(row.settings);
  const policy = settings.workspacePolicy || null;
  const hasVersionedPlan = typeof policy?.planId === 'string' && policy.planId.length > 0
    && Number.isSafeInteger(Number(policy.planVersion)) && Number(policy.planVersion) > 0;
  // Billing accounts may be bootstrapped for historical organizations with
  // zero wallet balance; their presence alone is not subscription evidence.
  const hasBillingArtifacts = Boolean(row.subscription_id
    || Number(row.period_count) > 0 || Number(row.payment_count) > 0 || Number(row.grant_count) > 0);
  const activePeriod = String(row.active_period_count || '0') !== '0';
  const activeGrant = String(row.active_grant_count || '0') !== '0';

  if (activePeriod && activeGrant) return {
    classification: 'active_billing_evidence',
    reviewRequired: true,
    reasons: ['An active subscription period and active credit grant already exist; do not recreate or duplicate them.'],
  };
  if (hasBillingArtifacts) return {
    classification: 'existing_billing_history_review',
    reviewRequired: true,
    reasons: ['Billing or lifecycle records exist; reconcile against immutable quotes, payment decisions, periods, and grants before any action.'],
  };
  if (!hasVersionedPlan) return {
    classification: 'legacy_plan_unverified',
    reviewRequired: true,
    reasons: ['No versioned organization plan selection is available; the current platform plan cannot establish historical terms.'],
  };
  return {
    classification: 'versioned_plan_no_billing_evidence',
    reviewRequired: true,
    reasons: ['A versioned plan selection exists but proves neither accepted terms nor payment; manual evidence and explicit approval are required.'],
  };
}

/** Read-only candidate listing. This intentionally never proposes an amount, paid state, period, or credit grant. */
async function previewSubscriptionReconciliation({ pool, limit = 50, offset = 0 } = {}) {
  if (!pool) pool = require('../db/pool').getPool();
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Reconciliation preview requires a SQL pool.');
  const boundedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  const boundedOffset = Math.max(0, Math.min(100000, Number.parseInt(offset, 10) || 0));
  const result = await pool.query(
    `SELECT o.id AS org_id,o.name AS organization_name,o.subscription_plan,o.settings,
            o.recharge_balance_inr,o.recharge_reserved_inr,
            a.org_id AS billing_account_id,s.org_id AS subscription_id,s.lifecycle_status,s.current_plan_id,s.current_plan_version,
            (SELECT COUNT(*) FROM billing_periods p WHERE p.org_id=o.id) AS period_count,
            (SELECT COUNT(*) FROM billing_periods p WHERE p.org_id=o.id AND p.period_kind='subscription' AND p.status='active') AS active_period_count,
            (SELECT COUNT(*) FROM billing_payment_requests pr WHERE pr.org_id=o.id) AS payment_count,
            (SELECT COUNT(*) FROM billing_credit_grants g WHERE g.org_id=o.id AND g.grant_kind='subscription') AS grant_count,
            (SELECT COUNT(*) FROM billing_credit_grants g WHERE g.org_id=o.id AND g.grant_kind='subscription' AND g.status='active') AS active_grant_count
       FROM organizations o
       LEFT JOIN organization_billing_accounts a ON a.org_id=o.id
       LEFT JOIN organization_subscriptions s ON s.org_id=o.id
      ORDER BY o.created_at,o.id LIMIT ? OFFSET ?`, [boundedLimit, boundedOffset]);
  const candidates = rowsOf(result).map((row) => {
    const settings = parseSettings(row.settings);
    const workspacePolicy = settings.workspacePolicy || null;
    const status = classify(row);
    return Object.freeze({
      organization: Object.freeze({ id: row.org_id, name: row.organization_name || null,
        legacyPlanName: row.subscription_plan || null, workspacePlanId: workspacePolicy?.planId || null,
        workspacePlanVersion: Number.isSafeInteger(Number(workspacePolicy?.planVersion))
          ? Number(workspacePolicy.planVersion) : null }),
      lifecycle: Object.freeze({ subscriptionIdPresent: Boolean(row.subscription_id),
        lifecycleStatus: row.lifecycle_status || null, currentPlanId: row.current_plan_id || null,
        currentPlanVersion: row.current_plan_version == null ? null : Number(row.current_plan_version),
        billingAccountPresent: Boolean(row.billing_account_id) }),
      legacyBalanceEvidence: Object.freeze({ rechargeBalanceInr: row.recharge_balance_inr == null ? null : String(row.recharge_balance_inr),
        rechargeReservedInr: row.recharge_reserved_inr == null ? null : String(row.recharge_reserved_inr),
        note: 'Legacy recharge balance is not evidence of subscription payment or subscription credits.' }),
      evidenceCounts: Object.freeze({ periods: Number(row.period_count || 0), activePeriods: Number(row.active_period_count || 0),
        paymentRequests: Number(row.payment_count || 0), subscriptionGrants: Number(row.grant_count || 0),
        activeSubscriptionGrants: Number(row.active_grant_count || 0) }),
      ...status,
    });
  });
  return Object.freeze({ mode: 'read_only_preview', mutatesData: false, offset: boundedOffset, limit: boundedLimit,
    returned: candidates.length, candidates: Object.freeze(candidates),
    notice: 'No payment, entitlement, period, plan price, or credit grant is inferred. Every candidate requires manual evidence review and a separately approved reconciliation operation.' });
}

module.exports = { previewSubscriptionReconciliation, classify, parseSettings, rowsOf };
