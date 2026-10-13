'use strict';

const crypto = require('node:crypto');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { createMysqlSubscriptionQuoteRepository } = require('./modules/catalog/repositories/mysqlSubscriptionQuoteRepository');
const { createMysqlSubscriptionRepository } = require('./modules/subscriptions/repositories/mysqlSubscriptionRepository');
const { inventoryFrom, quoteTtlSeconds } = require('./subscriptionPurchaseComposition');
const { composeSubscriptionQuote } = require('./modules/catalog/subscriptionQuoteComposition');
const { shiftCalendarDays } = require('./modules/subscriptions/periodMath');

function rowsOf(result) {
  const value = Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(value) ? value : value?.rows || [];
}
function objectValue(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function fail(code, message, statusCode = 409) { throw Object.assign(new Error(message), { code, statusCode }); }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32); }
// Financial command fingerprints must be full SHA-256 digests; shortened hashes are only for IDs.
function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function renewalQuotePayable({ status, validUntil, pendingPayment, paidAt, now = Date.now() } = {}) {
  return !paidAt && !pendingPayment && validUntil != null && Date.parse(validUntil) > now
    && ['draft', 'accepted'].includes(String(status || '').toLowerCase());
}

function createSubscriptionRenewalComposition({ pool: suppliedPool, getPlanVersion, listAvailablePlans = async () => [], idSource = { newId: (kind) => `${kind}-${crypto.randomUUID()}` },
  clock = { now: () => new Date().toISOString() }, quoteTtlSeconds: ttlOverride, renewalNoticeDays = 7, billingTimeZone = 'UTC' } = {}) {
  if (typeof getPlanVersion !== 'function') throw new TypeError('Subscription renewal requires a canonical plan version reader.');
  if (!Number.isSafeInteger(renewalNoticeDays) || renewalNoticeDays < 0) throw new TypeError('renewalNoticeDays must be a non-negative integer.');
  const pool = suppliedPool || require('../db/pool').getPool();
  const unitOfWork = createMysqlUnitOfWork({ pool, operationStore, idSource, clock });
  const quoteRepository = createMysqlSubscriptionQuoteRepository();
  const subscriptionRepository = createMysqlSubscriptionRepository();

  async function state(orgId) {
    const result = rowsOf(await pool.query(
      `SELECT s.lifecycle_status,s.billing_access_state,s.current_plan_id,s.current_plan_version,s.version AS subscription_version,s.restriction_deadline,
              p.id AS period_id,p.starts_at,p.ends_at,p.status AS period_status,p.terms_snapshot_json,
              q.id AS quote_id,q.status AS quote_status,q.version AS quote_version,q.total_units,q.asset,q.scale,
              q.valid_until,q.created_at,q.paid_at,q.terms_snapshot_json AS quote_snapshot,
              (SELECT COUNT(*) FROM billing_payment_requests pr WHERE pr.org_id=q.org_id AND pr.quote_id=q.id
                 AND pr.status IN ('pending_verification','needs_clarification','clarification_requested')) AS pending_payments,
              (SELECT JSON_OBJECT('id',g.id,'status',g.status,'periodId',g.period_id,'requestedUntil',g.requested_until,
                  'grantedUntil',g.granted_until,'version',g.version)
                 FROM billing_subscription_grace_requests g WHERE g.org_id=s.org_id
                   AND g.period_id=p.id ORDER BY g.created_at DESC LIMIT 1) AS grace_request,
              (SELECT JSON_OBJECT('periodId',bp.id,'status',bp.status,'startsAt',bp.starts_at,'endsAt',bp.ends_at)
                 FROM billing_subscription_period_links sl JOIN billing_periods bp
                   ON bp.org_id=sl.org_id AND bp.id=sl.period_id
                WHERE sl.org_id=s.org_id AND sl.purpose='renewal' AND sl.period_state='scheduled'
                ORDER BY sl.created_at DESC LIMIT 1) AS scheduled_renewal
         FROM organization_subscriptions s
         LEFT JOIN billing_periods p ON p.org_id=s.org_id AND p.period_kind='subscription'
           AND p.id=(SELECT p2.id FROM billing_periods p2 WHERE p2.org_id=s.org_id AND p2.period_kind='subscription'
             AND p2.status IN ('active','expired') ORDER BY p2.ends_at DESC,p2.created_at DESC LIMIT 1)
         LEFT JOIN billing_subscription_period_links l ON l.org_id=s.org_id AND l.purpose='renewal'
           AND l.id=(SELECT l2.id FROM billing_subscription_period_links l2 WHERE l2.org_id=s.org_id AND l2.purpose='renewal'
             ORDER BY l2.created_at DESC LIMIT 1)
         LEFT JOIN billing_quotes q ON q.org_id=l.org_id AND q.id=l.quote_id AND q.quote_type='renewal'
        WHERE s.org_id=? LIMIT 1`, [orgId],
    ));
    if (!result.length) return null;
    const row = result[0];
    const now = Date.parse(clock.now());
    const endsAt = row.ends_at == null ? null : new Date(row.ends_at).toISOString();
    const startsAt = row.starts_at == null ? null : new Date(row.starts_at).toISOString();
    const inWindow = endsAt != null && now >= Date.parse(shiftCalendarDays(endsAt, -renewalNoticeDays, { timeZone: billingTimeZone }));
    const expired = endsAt != null && now >= Date.parse(endsAt);
    const snapshot = row.quote_id == null ? null : objectValue(row.quote_snapshot);
    const validUntil = row.valid_until == null ? null : new Date(row.valid_until).toISOString();
    const quoteExpired = validUntil == null || Date.parse(validUntil) <= now;
    const graceRequest = row.grace_request == null ? null : Object.freeze(typeof row.grace_request === 'string' ? JSON.parse(row.grace_request) : row.grace_request);
    const quote = row.quote_id == null ? null : Object.freeze({ quoteId: row.quote_id, purpose: 'renewal', status: row.quote_status,
      version: Number(row.quote_version), paymentAmount: { asset: row.asset, units: String(row.total_units), scale: Number(row.scale) },
      includedCredits: snapshot.includedCredits, plan: snapshot.plan, inventory: snapshot.inventory, lines: snapshot.lines,
      subtotal: snapshot.subtotal, discounts: snapshot.discounts, totalTax: snapshot.totalTax, total: snapshot.total,
      createdAt: new Date(row.created_at).toISOString(), validUntil, expired: quoteExpired,
      pendingPayment: Number(row.pending_payments || 0) > 0, paidAt: row.paid_at == null ? null : new Date(row.paid_at).toISOString(),
      payable: renewalQuotePayable({ status: row.quote_status, validUntil, pendingPayment: Number(row.pending_payments || 0) > 0,
        paidAt: row.paid_at, now }),
    });
    const scheduledRenewal = row.scheduled_renewal == null ? null
      : Object.freeze(typeof row.scheduled_renewal === 'string' ? JSON.parse(row.scheduled_renewal) : row.scheduled_renewal);
    const periodSnapshot = row.terms_snapshot_json == null ? null : objectValue(row.terms_snapshot_json);
    const trial = periodSnapshot?.source === 'free_trial';
    return Object.freeze({ subscription: Object.freeze({ lifecycleStatus: row.lifecycle_status, accessState: row.billing_access_state,
      version: Number(row.subscription_version), restrictionDeadline: row.restriction_deadline == null ? null : new Date(row.restriction_deadline).toISOString(),
      planId: row.current_plan_id, planVersion: row.current_plan_version == null ? null : Number(row.current_plan_version) }),
      graceRequest,
      scheduledRenewal,
      availablePlans: trial ? await listAvailablePlans(clock.now()) : [],
      period: row.period_id ? Object.freeze({ periodId: row.period_id, status: row.period_status, startsAt, endsAt, isTrial: trial,
        trialDays: trial ? Number(periodSnapshot.trialDays) : null, renewalEligible: inWindow, overdue: expired }) : null, quote });
  }

  async function inventory(orgId) {
    const [workspaces, seats, addons] = await Promise.all([
      pool.query('SELECT id,industry FROM workspaces WHERE org_id=? ORDER BY id', [orgId]),
      pool.query("SELECT COUNT(*) AS seat_count FROM org_members WHERE org_id=? AND COALESCE(NULLIF(status,''),'Active')='Active'", [orgId]),
      pool.query("SELECT workspace_id,period_ends_at FROM billing_workspace_addons WHERE org_id=? AND status='active' AND workspace_id IS NOT NULL", [orgId]),
    ]);
    const now = Date.parse(clock.now());
    const addonIds = new Set(rowsOf(addons).filter((r) => r.period_ends_at == null || Date.parse(r.period_ends_at) > now).map((r) => r.workspace_id));
    return inventoryFrom(rowsOf(workspaces), Number(rowsOf(seats)[0]?.seat_count || 0), addonIds);
  }

  async function readRenewal(orgId) { return state(orgId); }

  async function createRenewalQuote({ orgId, requestKey, targetPlanId, targetPlanVersion } = {}) {
    const current = await state(orgId);
    if (!current) return null;
    if (!current.period || !current.period.renewalEligible) fail('RENEWAL_NOT_OPEN', 'Renewal quotes are available during the final 7 days of the subscription period and after expiry.');
    if (current.quote?.pendingPayment) fail('RENEWAL_PAYMENT_PENDING', 'A renewal payment is already awaiting review.', 409);
    if (current.quote && !current.quote.expired && current.quote.payable) {
      if (current.period.isTrial && (current.quote.plan?.id !== targetPlanId || current.quote.plan?.version !== targetPlanVersion)) {
        fail('TRIAL_CONVERSION_QUOTE_EXISTS', 'An active trial conversion quote already exists. Let it expire or submit its payment before choosing another plan.');
      }
      return current;
    }
    if (!current.subscription.planId || !current.subscription.planVersion) fail('SUBSCRIPTION_PLAN_UNAVAILABLE', 'The current subscription has no versioned plan.', 409);
    const now = new Date(clock.now()).toISOString();
    if (current.period.isTrial && (!targetPlanId || !Number.isSafeInteger(targetPlanVersion))) fail('TRIAL_PLAN_REQUIRED', 'Choose a published plan to start after the free trial.');
    if (!current.period.isTrial && targetPlanId && (targetPlanId !== current.subscription.planId || targetPlanVersion !== current.subscription.planVersion)) fail('RENEWAL_PLAN_CHANGE_UNAVAILABLE', 'Plan changes must use the plan upgrade flow.');
    const planVersion = await getPlanVersion({ planId: current.period.isTrial ? targetPlanId : current.subscription.planId,
      version: current.period.isTrial ? targetPlanVersion : current.subscription.planVersion });
    if (!planVersion || planVersion.status !== 'published') fail('SUBSCRIPTION_PLAN_VERSION_UNAVAILABLE', 'The current plan version is unavailable for renewal.');
    const renewalInventory = await inventory(orgId);
    const key = `subscription-renewal-${hash(orgId)}-${hash(requestKey || 'renewal')}`;
    const quoteId = `billing-subscription-renewal-quote-${hash(`${orgId}\0${key}`)}`;
    const quote = composeSubscriptionQuote({ planVersion, purpose: 'renewal', orgId, quoteId, version: 1,
      inventory: renewalInventory, createdAt: now, validUntil: new Date(Date.parse(now) + quoteTtlSeconds(ttlOverride) * 1000).toISOString() });
    const opId = `subscription-renewal-${hash(`${orgId}\0${key}`)}`;
    await unitOfWork.runFinancial({ orgId, operationId: opId,
        requestFingerprint: fingerprint({ orgId, quoteId, planId: planVersion.planId, planVersion: planVersion.version, inventory: renewalInventory }),
      callback: async (tx) => {
        const latest = await subscriptionRepository.getOrganizationSubscription(tx, { orgId, forUpdate: true });
        if (!latest || latest.currentPlanId !== current.subscription.planId || latest.currentPlanVersion !== current.subscription.planVersion) fail('VERSION_CONFLICT', 'Subscription plan changed. Refresh before quoting renewal.');
        const prior = rowsOf(await tx.query(`SELECT l.id FROM billing_subscription_period_links l
          LEFT JOIN billing_quotes q ON q.org_id=l.org_id AND q.id=l.quote_id
          WHERE l.org_id=? AND l.purpose='renewal' AND l.period_state IN ('awaiting_payment','scheduled')
            AND (l.period_state='scheduled' OR q.valid_until>?) ORDER BY l.created_at DESC LIMIT 1 FOR UPDATE`, [orgId, now]));
        if (prior.length) fail('RENEWAL_PAYMENT_PENDING', 'A renewal quote or funded renewal already exists.');
        const existing = await quoteRepository.getByIdempotencyKey(tx, { orgId, idempotencyKey: key, forUpdate: true });
        if (existing) return existing;
        await quoteRepository.create(tx, { orgId, id: quoteId, idempotencyKey: key, quote });
        const periodLinkId = idSource.newId('billing-subscription-period-link');
        await subscriptionRepository.linkPeriod(tx, { id: periodLinkId, orgId,
          periodId: null, quoteId, paymentRequestId: null, purpose: 'renewal', periodState: 'awaiting_payment',
          planId: planVersion.planId, planVersion: planVersion.version, effectiveAt: current.period.endsAt,
          supersedesPeriodId: current.period.periodId, now });
        return { quoteId, periodLinkId, created: true };
      } });
    return state(orgId);
  }

  return Object.freeze({ readRenewal, createRenewalQuote });
}

module.exports = { createSubscriptionRenewalComposition, renewalQuotePayable };
