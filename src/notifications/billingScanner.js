'use strict';

// A bounded, read-only scan over authoritative billing facts. Intended for the
// existing scheduler/cron (never infer billing state from frontend balances).
// Dedupe keys are stable across retries, nodes and worker restarts.
const { getPool } = require('../db/pool');
const { publishQuietly } = require('./service');

function rows(result) { return Array.isArray(result?.rows) ? result.rows : Array.isArray(result?.[0]) ? result[0] : []; }
function iso(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }
function options(input = {}) {
  const now = iso(input.now || new Date());
  const limit = Number(input.limit || 100);
  const leadDays = Number(input.leadDays || 7);
  const lowCreditThresholdInr = Number(input.lowCreditThresholdInr ?? 100);
  if (!now || !Number.isInteger(limit) || limit < 1 || limit > 500
    || !Number.isInteger(leadDays) || leadDays < 1 || leadDays > 90
    || !Number.isFinite(lowCreditThresholdInr) || lowCreditThresholdInr <= 0 || lowCreditThresholdInr > 100000)
    throw new TypeError('Invalid notification scan options.');
  return { now, limit, leadDays, lowCreditThresholdInr };
}

async function scanProductNotifications(input = {}, { pool = getPool(), publish = publishQuietly } = {}) {
  const { now, limit, leadDays, lowCreditThresholdInr } = options(input);
  const horizon = new Date(Date.parse(now) + leadDays * 86400000).toISOString();
  const results = { periodCandidates: 0, lowCreditCandidates: 0, attempted: 0 };
  // Subscription periods are canonical, including trials recorded as a
  // free_trial terms snapshot. Exclude expired, superseded and unpaid periods.
  const periodRows = rows(await pool.query(
    `SELECT p.id,p.org_id,p.ends_at,p.terms_snapshot_json
       FROM billing_periods p
      WHERE p.period_kind='subscription' AND p.status='active'
        AND p.ends_at>? AND p.ends_at<=?
        AND NOT EXISTS (
          SELECT 1 FROM billing_periods nextp WHERE nextp.org_id=p.org_id
          AND nextp.period_kind='subscription'
          AND nextp.status IN ('active','scheduled')
          AND nextp.starts_at>=p.ends_at
        )
      ORDER BY p.ends_at,p.id LIMIT ?`,
    [now,horizon,limit]));
  results.periodCandidates = periodRows.length;
  for (const row of periodRows) {
    let snapshot;
    try { snapshot = typeof row.terms_snapshot_json === 'string' ? JSON.parse(row.terms_snapshot_json) : row.terms_snapshot_json; }
    catch { continue; } // Never guess trial vs paid from unreadable terms.
    const isTrial = snapshot?.source === 'free_trial';
    const eventKey = isTrial ? 'billing.trial_expiring' : 'billing.subscription_expiring';
    const date = iso(row.ends_at);
    if (!date) continue;
    const payload = {
      orgId: row.org_id, eventKey, dedupeKey: `period:${row.id}:expiring:${leadDays}d`,
      title: isTrial ? 'Trial expiring soon' : 'Subscription expiring soon',
      message: `Your ${isTrial ? 'trial' : 'subscription'} expires on ${date.slice(0,10)}. Review your billing settings to avoid an interruption.`,
      actionPath: '/administration/billing',
    };
    for (const audience of ['organization','platform']) {
      results.attempted++;
      await publish({ ...payload, audience, actionPath: audience === 'platform'
        ? '/admin/organizations/' + encodeURIComponent(row.org_id) : payload.actionPath });
    }
  }

  // Available credit balance = posted balance minus reservations. Exclude
  // closed accounts and expired/inactive grants. Only accounts with actual
  // ledger positions qualify; a missing wallet is not a "low balance".
  const lowRows = rows(await pool.query(
    `SELECT p.org_id, SUM(p.balance_units-p.reserved_units) AS available_units
       FROM billing_credit_positions p
       JOIN billing_credit_accounts a ON a.org_id=p.org_id AND a.id=p.account_id
       JOIN billing_credit_grants g ON g.org_id=p.org_id AND g.id=p.grant_id
      WHERE a.status='active' AND p.asset='INR' AND p.scale=2
        AND g.status='active' AND (g.expires_at IS NULL OR g.expires_at>?)
      GROUP BY p.org_id
      HAVING available_units<=?
      ORDER BY p.org_id LIMIT ?`,
    [now,Math.round(lowCreditThresholdInr*100),limit]));
  results.lowCreditCandidates = lowRows.length;
  // One alert per organization each seven-day UTC epoch: no repeated notices
  // on every scan tick, but a persistently low wallet can be re-notified.
  const epoch = Math.floor(Date.parse(now) / (7 * 86400000));
  for (const row of lowRows) {
    const remaining = (Number(row.available_units) / 100).toFixed(2);
    const payload = {
      orgId:row.org_id, eventKey:'billing.credits_low',
      dedupeKey:`credit-low:${row.org_id}:${epoch}:${lowCreditThresholdInr}`,
      title:'Low credit balance',
      message:`Available calling credits are ₹${remaining}, at or below the ₹${lowCreditThresholdInr.toFixed(2)} alert threshold.`,
      actionPath:'/administration/billing',
    };
    for (const audience of ['organization','platform']) {
      results.attempted++;
      await publish({ ...payload, audience, actionPath: audience === 'platform'
        ? '/admin/organizations/' + encodeURIComponent(row.org_id) : payload.actionPath });
    }
  }
  return results;
}

module.exports = { scanProductNotifications, options };
