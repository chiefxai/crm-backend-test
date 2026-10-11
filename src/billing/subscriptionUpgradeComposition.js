'use strict';

const crypto = require('node:crypto');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { createMysqlSubscriptionQuoteRepository } = require('./modules/catalog/repositories/mysqlSubscriptionQuoteRepository');
const { createMysqlSubscriptionRepository } = require('./modules/subscriptions/repositories/mysqlSubscriptionRepository');
const { composeImmediateUpgradeQuote } = require('./modules/catalog/subscriptionUpgradeQuote');
const { validateUpgradeQuoteCommand } = require('./contracts/subscription');
const { inventoryFrom, quoteTtlSeconds } = require('./subscriptionPurchaseComposition');

function rowsOf(result) {
  const value = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(value) ? value : value?.rows || [];
}
function valueObject(value, name) {
  const result = typeof value === 'string' ? JSON.parse(value) : value;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError(`${name} must be a JSON object.`);
  return result;
}
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function fail(code, message, statusCode = 409) { throw Object.assign(new Error(message), { code, statusCode }); }

function createSubscriptionUpgradeComposition({ pool: suppliedPool, getPlanVersion,
  idSource = { newId: (kind) => `${kind}-${crypto.randomUUID()}` },
  clock = { now: () => new Date().toISOString() }, quoteTtlSeconds: ttlOverride } = {}) {
  if (typeof getPlanVersion !== 'function') throw new TypeError('Subscription upgrade requires a canonical plan version reader.');
  const pool = suppliedPool || require('../db/pool').getPool();
  const unitOfWork = createMysqlUnitOfWork({ pool, operationStore, idSource, clock });
  const quoteRepository = createMysqlSubscriptionQuoteRepository();
  const subscriptionRepository = createMysqlSubscriptionRepository();

  async function inventory(orgId) {
    const [workspaces, seats, addons] = await Promise.all([
      pool.query('SELECT id,industry FROM workspaces WHERE org_id=? ORDER BY id', [orgId]),
      pool.query("SELECT COUNT(*) AS seat_count FROM org_members WHERE org_id=? AND COALESCE(NULLIF(status,''),'Active')='Active'", [orgId]),
      pool.query("SELECT workspace_id,period_ends_at FROM billing_workspace_addons WHERE org_id=? AND status='active' AND workspace_id IS NOT NULL", [orgId]),
    ]);
    const now = Date.parse(clock.now());
    const activeAddons = new Set(rowsOf(addons).filter((row) => row.period_ends_at == null || Date.parse(row.period_ends_at) > now).map((row) => row.workspace_id));
    return inventoryFrom(rowsOf(workspaces), Number(rowsOf(seats)[0]?.seat_count || 0), activeAddons);
  }

  async function currentState(orgId) {
    const row = rowsOf(await pool.query(
      `SELECT s.lifecycle_status,s.billing_access_state,s.current_plan_id,s.current_plan_version,s.version AS subscription_version,
              p.id AS period_id,p.status AS period_status,p.starts_at,p.ends_at,p.terms_snapshot_json
         FROM organization_subscriptions s
         LEFT JOIN billing_periods p ON p.org_id=s.org_id AND p.period_kind='subscription'
           AND p.id=s.current_period_id AND p.status='active'
        WHERE s.org_id=? LIMIT 1`, [orgId],
    ))[0];
    if (!row) return null;
    const now = new Date(clock.now()).toISOString();
    const snapshot = row.terms_snapshot_json == null ? null : valueObject(row.terms_snapshot_json, 'current period snapshot');
    const currentTerms = snapshot?.terms || snapshot?.plan?.terms;
    const currentPlan = snapshot?.plan || (row.current_plan_id ? { id: row.current_plan_id, version: Number(row.current_plan_version) } : null);
    const currentPeriod = row.period_id ? Object.freeze({ periodId: row.period_id, status: row.period_status,
      startsAt: row.starts_at, endsAt: row.ends_at, planId: currentPlan?.id || row.current_plan_id,
      planVersion: currentPlan?.version == null ? Number(row.current_plan_version) : Number(currentPlan.version) }) : null;
    return Object.freeze({ orgId, now, subscription: Object.freeze({ lifecycleStatus: row.lifecycle_status,
      billingAccessState: row.billing_access_state, planId: row.current_plan_id,
      planVersion: row.current_plan_version == null ? null : Number(row.current_plan_version), version: Number(row.subscription_version) }),
      currentPeriod, currentTerms });
  }

  async function readQuote(orgId, quoteId) {
    const row = rowsOf(await pool.query(
      `SELECT id,quote_type,status,version,idempotency_key,terms_snapshot_json,total_units,asset,scale,valid_until,created_at,paid_at
         FROM billing_quotes WHERE org_id=? AND id=? AND quote_type='adjustment' LIMIT 1`, [orgId, quoteId],
    ))[0];
    if (!row) return null;
    const snapshot = valueObject(row.terms_snapshot_json, 'upgrade quote snapshot');
    const expired = row.valid_until == null || Date.parse(row.valid_until) <= Date.parse(clock.now());
    return Object.freeze({ quoteId: row.id, purpose: 'adjustment', status: row.status, version: Number(row.version),
      plan: snapshot.plan, inventory: snapshot.inventory, lines: snapshot.lines, subtotal: snapshot.subtotal,
      discounts: snapshot.discounts, totalTax: snapshot.totalTax, total: snapshot.total,
      paymentAmount: { asset: row.asset, units: String(row.total_units), scale: Number(row.scale) },
      includedCredits: snapshot.includedCredits, adjustment: snapshot.adjustment,
      createdAt: new Date(row.created_at).toISOString(), validUntil: row.valid_until == null ? null : new Date(row.valid_until).toISOString(), expired,
      payable: false, payment: Object.freeze({ submissionEnabled: false, submissionPath: null,
        reason: 'UPGRADE_ENTITLEMENT_INTEGRATION_NOT_IMPLEMENTED' }) });
  }

  async function createImmediateUpgradeQuote({ orgId, targetPlanId, targetPlanVersion, effectiveAt = 'immediate', trustedContext } = {}) {
    if (effectiveAt !== 'immediate') fail('UPGRADE_MODE_UNAVAILABLE', 'This preview endpoint currently supports immediate upgrades only.', 400);
    const current = await currentState(orgId);
    if (!current) return null;
    if (current.subscription.billingAccessState !== 'operational' || !current.currentPeriod || !current.currentTerms) {
      fail('UPGRADE_NOT_AVAILABLE', 'An operational organization with an active paid period is required.');
    }
    const command = validateUpgradeQuoteCommand({ schemaVersion: 1, orgId, periodId: current.currentPeriod.periodId,
      targetPlanId, targetPlanVersion, effectiveAt }, trustedContext);
    const planVersion = await getPlanVersion({ planId: command.targetPlanId, version: command.targetPlanVersion });
    if (!planVersion || planVersion.status !== 'published') fail('SUBSCRIPTION_PLAN_VERSION_UNAVAILABLE', 'The requested target plan version is not published.');
    const quoteNow = new Date(clock.now()).toISOString();
    const requestKey = command.context.operationId;
    const idempotencyKey = `subscription-upgrade-${hash(orgId).slice(0, 24)}-${hash(requestKey).slice(0, 24)}`;
    const quoteId = `billing-subscription-upgrade-${hash(`${orgId}\0${requestKey}`).slice(0, 32)}`;
    const inventorySnapshot = await inventory(orgId);
    const quote = composeImmediateUpgradeQuote({ currentPeriod: current.currentPeriod, currentTerms: current.currentTerms,
      targetPlanVersion: planVersion, orgId, inventory: inventorySnapshot, quoteId, version: 1,
      createdAt: quoteNow, validUntil: new Date(Date.parse(quoteNow) + quoteTtlSeconds(ttlOverride) * 1000).toISOString() });
    const fingerprintData = { orgId, requestKey, currentPeriod: current.currentPeriod, currentPlanVersion: current.subscription.planVersion,
      targetPlanId: planVersion.planId, targetPlanVersion: planVersion.version, inventory: inventorySnapshot,
      quoteFingerprint: quote.fingerprint };
    await unitOfWork.runFinancial({ orgId, operationId: idempotencyKey,
      requestFingerprint: `sha256:${hash(JSON.stringify(fingerprintData))}`,
      callback: async (tx) => {
        const latest = await subscriptionRepository.getOrganizationSubscription(tx, { orgId, forUpdate: true });
        if (!latest || latest.version !== current.subscription.version || latest.currentPeriodId !== current.currentPeriod.periodId
            || latest.billingAccessState !== 'operational') fail('VERSION_CONFLICT', 'Subscription changed; refresh the upgrade preview.');
        const activePlanChange = rowsOf(await tx.query(
          `SELECT id FROM billing_quotes WHERE org_id=? AND quote_type='adjustment'
             AND status IN ('draft','accepted','pending_payment') AND valid_until>? AND id<>? LIMIT 1 FOR UPDATE`,
          [orgId, quoteNow, quoteId],
        ));
        if (activePlanChange.length) fail('PLAN_CHANGE_PENDING', 'An unexpired plan-change preview already exists.');
        const renewal = rowsOf(await tx.query(
          `SELECT id FROM billing_subscription_period_links
            WHERE org_id=? AND purpose='renewal' AND period_state IN ('awaiting_payment','scheduled') LIMIT 1 FOR UPDATE`, [orgId],
        ));
        if (renewal.length) fail('PLAN_CHANGE_CONFLICT', 'A renewal quote or funded renewal is already open.');
        const existing = await quoteRepository.getByIdempotencyKey(tx, { orgId, idempotencyKey, forUpdate: true });
        if (existing) return existing;
        await quoteRepository.create(tx, { orgId, id: quoteId, idempotencyKey, quote });
      } });
    return readQuote(orgId, quoteId);
  }

  return Object.freeze({ createImmediateUpgradeQuote, readQuote });
}

module.exports = { createSubscriptionUpgradeComposition };
