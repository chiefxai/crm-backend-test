'use strict';

const FEATURE_FLAG = 'BILLING_SUBSCRIPTION_ACCESS_ENFORCEMENT_ENABLED';
const BILLING_PATH = /^\\/api\\/billing(?:\\/|$)/;
const NOTIFICATION_READ_PATH = '/api/notifications/read';
const SESSION_PATHS = new Set(['/api/auth/me', '/api/auth/roles', '/api/settings/me']);
const BILLING_SUSPENSION_CAUSES = new Set([
  'initial_subscription_unpaid', 'subscription_payment_overdue', 'subscription_expired',
]);
const NON_BILLING_SUSPENSION_CAUSES = new Set(['manual', 'security', 'manual_suspension', 'security_suspension']);
const rowsOf = (value) => Array.isArray(value) && Array.isArray(value[0]) ? value[0]
  : Array.isArray(value) ? value : value?.rows || [];
function deadlineTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  const raw = String(value);
  const normalized = /^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d/.test(raw)
    ? `${raw.replace(' ', 'T').replace(/(\\.\\d{3})\\d+$/, '$1')}Z` : raw;
  return Date.parse(normalized);
}

function enabled() { return process.env[FEATURE_FLAG] === 'true'; }

/**
 * Enforce subscription access at the authenticated request boundary. The
 * organization id is always taken from verified membership, never a header or
 * body. Billing endpoints remain available during billing recovery/overdue
 * suspension so an authorized billing administrator can resolve payment.
 */
async function enforceSubscriptionAccess(req, res, { pool, isEnabled = enabled } = {}) {
  if (!isEnabled()) return true;
  const path = new URL(req.originalUrl || req.url, 'http://local').pathname.toLowerCase();
  const notificationRead = req.method === 'POST' && path === NOTIFICATION_READ_PATH;
  let result;
  try {
    const db = pool || require('../db/pool').getPool();
    result = await db.query(
      'SELECT billing_access_state,billing_suspension_cause,restriction_deadline FROM organization_subscriptions WHERE org_id=? LIMIT 1',
      [req.orgId],
    );
  } catch (_error) {
    res.status(503).json({ code: 'SUBSCRIPTION_ACCESS_UNAVAILABLE', error: 'Subscription access status is temporarily unavailable.' });
    return false;
  }

  const subscription = rowsOf(result)[0];
  if (!subscription) {
    res.status(503).json({ code: 'SUBSCRIPTION_ACCESS_UNAVAILABLE', error: 'Subscription access status is not configured for this organization.' });
    return false;
  }
  const rawDeadline = subscription.restriction_deadline || null;
  const deadlineMs = rawDeadline == null ? null : deadlineTimestamp(rawDeadline);
  if (rawDeadline != null && !Number.isFinite(deadlineMs)) {
    res.status(503).json({ code: 'SUBSCRIPTION_ACCESS_UNAVAILABLE', error: 'Subscription restriction deadline is invalid.' });
    return false;
  }
  const deadlinePassed = deadlineMs !== null && deadlineMs <= Date.now();
  req.subscriptionAccess = Object.freeze({
    state: subscription.billing_access_state,
    cause: subscription.billing_suspension_cause || null,
    restrictionDeadline: rawDeadline,
    deadlinePassed,
  });

  const state = String(subscription.billing_access_state || '').toLowerCase();
  const cause = String(subscription.billing_suspension_cause || '').toLowerCase();
  if (NON_BILLING_SUSPENSION_CAUSES.has(cause)) {
    res.status(403).json({ code: 'ORGANIZATION_ACCESS_SUSPENDED', error: 'Organization access is suspended. Contact the platform team.' });
    return false;
  }
  if (state === 'operational') {
    if (!deadlinePassed) return true;
    if (BILLING_PATH.test(path) || notificationRead) return true;
    res.status(403).json({ code: 'SUBSCRIPTION_SUSPENDED', error: 'Subscription access is suspended. Resolve billing or contact the platform team.' });
    return false;
  }
  const recoveryRead = req.method === 'GET' && SESSION_PATHS.has(path);

  if (state === 'billing_recovery') {
    if (BILLING_PATH.test(path) || recoveryRead || notificationRead) return true;
    res.status(402).json({ code: 'SUBSCRIPTION_PAYMENT_REQUIRED', error: 'Complete subscription payment to use organization features.' });
    return false;
  }

  if (state === 'billing_suspended') {
    if (BILLING_SUSPENSION_CAUSES.has(cause) && (BILLING_PATH.test(path) || recoveryRead || notificationRead)) return true;
    res.status(403).json({ code: 'SUBSCRIPTION_SUSPENDED', error: 'Subscription access is suspended. Resolve billing or contact the platform team.' });
    return false;
  }

  // Unknown lifecycle states must not silently grant access after rollout.
  res.status(503).json({ code: 'SUBSCRIPTION_ACCESS_UNAVAILABLE', error: 'Subscription access status is not recognized.' });
  return false;
}

module.exports = { FEATURE_FLAG, enabled, enforceSubscriptionAccess, BILLING_SUSPENSION_CAUSES, NON_BILLING_SUSPENSION_CAUSES };
