'use strict';

const { getPool } = require('../db/pool');
const { getWorkspacePlans } = require('../platform/billingSettings');

/** Plan allowances and issued credit grants are different accounting facts.
 * No read path may create credits or interpret legacy recharge balances as grants.
 */
function parsePolicy(settings) {
  try {
    const decoded = typeof settings === 'string' ? JSON.parse(settings) : settings;
    const policy = decoded?.workspacePolicy;
    return policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : null;
  } catch { return null; }
}
function inrAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000000
    || Math.round(value * 100) / 100 !== value) return null;
  return { asset: 'INR', scale: 2, units: String(Math.round(value * 100)) };
}
function resolvePlanMonthlyCredits(policy, catalog) {
  const persisted = policy?.pricing?.monthlySubscriptionCreditsInr;
  if (persisted !== undefined) return { amount: inrAmount(persisted), source: 'organization_plan_snapshot' };
  // Older organizations lost this setting at creation. Reconstruct it only
  // when the saved version still matches the exact platform catalog version.
  if (policy?.planId && policy?.planVersion && Number(policy.planVersion) === Number(catalog?.version)) {
    const plan = catalog.plans?.find(row => row.id === policy.planId);
    if (plan) return { amount: inrAmount(plan.pricing?.monthlySubscriptionCreditsInr ?? 0),
      source: 'matching_platform_plan_version' };
  }
  return { amount: null, source: 'unverified_legacy_plan' };
}

async function readPlanCreditStatus(orgId, { pool = getPool(), getPlans = getWorkspacePlans, now = new Date() } = {}) {
  if (typeof orgId !== 'string' || !orgId.trim()) throw new TypeError('orgId is required');
  const { rows } = await pool.query(
    'SELECT subscription_plan,settings FROM organizations WHERE id=? LIMIT 1', [orgId],
  );
  if (!rows?.length) return null;
  const policy = parsePolicy(rows[0].settings);
  const plans = policy?.pricing?.monthlySubscriptionCreditsInr === undefined ? await getPlans() : null;
  const entitlement = resolvePlanMonthlyCredits(policy, plans);
  const configured = entitlement.amount;
  const base = {
    planName: rows[0].subscription_plan || null,
    planId: policy?.planId || null,
    configuredMonthlyCredits: configured,
    entitlementSource: entitlement.source,
    issuedThisPeriod: null,
    currentPeriod: null,
    state: 'unverified_plan',
  };
  if (!configured) return base;
  if (BigInt(configured.units) === 0n) return { ...base, state: 'no_included_credits' };

  const when = now.toISOString();
  const periods = await pool.query(
    `SELECT id,status,starts_at,ends_at FROM billing_periods
      WHERE org_id=? AND period_kind='subscription' AND starts_at<=? AND ends_at>?
      ORDER BY starts_at DESC,id DESC LIMIT 1`,
    [orgId, when, when],
  );
  const period = periods.rows?.[0];
  if (!period) return { ...base, state: 'awaiting_approved_subscription' };
  const currentPeriod = { id: period.id, status: period.status,
    startsAt: new Date(period.starts_at).toISOString(), endsAt: new Date(period.ends_at).toISOString() };
  const grants = await pool.query(
    `SELECT id,status,amount_units,asset,scale FROM billing_credit_grants
       WHERE org_id=? AND period_id=? AND grant_kind='subscription'
       ORDER BY created_at DESC,id DESC LIMIT 1`,
    [orgId, period.id],
  );
  const grant = grants.rows?.[0];
  if (grant && grant.status === 'active') return {
    ...base, currentPeriod, state: 'issued_to_organization_pool',
    issuedThisPeriod: { asset: grant.asset, units: String(grant.amount_units),
      scale: Number(grant.scale) },
  };
  if (period.status === 'active') return { ...base, currentPeriod, state: 'activation_incomplete' };
  const funding = await pool.query(
    `SELECT id FROM billing_payment_fulfillments
      WHERE org_id=? AND target_id=? AND fulfillment_kind='subscription_period'
      LIMIT 1`,
    [orgId, period.id],
  );
  return { ...base, currentPeriod,
    state: funding.rows?.length ? 'awaiting_period_activation' : 'awaiting_approved_subscription' };
}

module.exports = { parsePolicy, inrAmount, resolvePlanMonthlyCredits, readPlanCreditStatus };
