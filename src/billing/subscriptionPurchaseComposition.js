'use strict';

const crypto = require('node:crypto');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { createMysqlSubscriptionQuoteRepository } = require('./modules/catalog/repositories/mysqlSubscriptionQuoteRepository');
const { createMysqlSubscriptionRepository } = require('./modules/subscriptions/repositories/mysqlSubscriptionRepository');
const { createMysqlCreditRepository } = require('./modules/credits/repositories/mysqlCreditRepository');
const { planIssueGrant } = require('./modules/credits/domain');
const { organizationScope } = require('./kernel/scope');
const { createInitialPurchaseService } = require('./modules/subscriptions/initialPurchaseService');
const { resolveSubscriptionPolicy } = require('./modules/subscriptions/policy');

function rowsOf(result) {
  const value = Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(value) ? value : value?.rows || [];
}
function objectValue(value, name) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError(`${name} must be a JSON object.`);
  return parsed;
}
function quoteTtlSeconds(value = process.env.BILLING_SUBSCRIPTION_QUOTE_TTL_SECONDS) {
  const ttl = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 7 * 86400) {
    const error = new Error('Initial subscription quote TTL must be configured from 60 seconds to 7 days.');
    error.statusCode = 503;
    error.code = 'SUBSCRIPTION_QUOTE_POLICY_UNAVAILABLE';
    throw error;
  }
  return ttl;
}
function inventoryFrom(workspaces, seatCount, separatelyBilledWorkspaceIds) {
  if (!workspaces.length) throw new Error('Organization has no workspace inventory to quote.');
  const counts = new Map();
  for (const row of workspaces) {
    if (typeof row.industry !== 'string' || !row.industry.trim()) throw new Error('Workspace inventory contains an unset industry.');
    const code = row.industry.trim().toLowerCase();
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const snapshot = {
    workspaces: workspaces.map((row) => [row.id, row.industry]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    seatCount,
    separatelyBilledWorkspaceIds: [...separatelyBilledWorkspaceIds].sort(),
  };
  const version = `sha256:${crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`;
  return {
    workspaceCount: workspaces.length,
    industries: [...counts.entries()].map(([code, count]) => ({ code, count })),
    seatCount,
    separatelyBilledWorkspaceCount: separatelyBilledWorkspaceIds.size,
    version,
  };
}

/**
 * Server-side resolver and initial quote service composition. The resolver is
 * injected by platform startup and must synchronize the selected immutable
 * workspace-plan source version into the canonical published billing catalog.
 */
function createSubscriptionPurchaseComposition({
  pool: suppliedPool, resolvePlanVersion, idSource = { newId: (prefix) => `${prefix}-${crypto.randomUUID()}` },
  clock = { now: () => new Date().toISOString() }, quoteTtlSeconds: ttlOverride,
  subscriptionPolicy,
} = {}) {
  const pool = suppliedPool || require('../db/pool').getPool();
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('Subscription purchase composition requires a MySQL pool.');
  if (typeof resolvePlanVersion !== 'function') throw new TypeError('Subscription purchase composition requires resolvePlanVersion().');
  const policy = resolveSubscriptionPolicy(subscriptionPolicy || {});
  const unitOfWork = createMysqlUnitOfWork({ pool, operationStore, idSource, clock });
  const quoteRepository = createMysqlSubscriptionQuoteRepository();
  const subscriptionRepository = createMysqlSubscriptionRepository();
  const creditRepository = createMysqlCreditRepository({ idSource, clock });

  async function resolveOrg(orgId) {
    const rows = rowsOf(await pool.query('SELECT id,subscription_plan,settings FROM organizations WHERE id=? LIMIT 1', [orgId]));
    if (!rows.length) return null;
    const settings = objectValue(rows[0].settings || {}, 'organization.settings');
    const workspacePolicy = settings.workspacePolicy;
    if (!workspacePolicy || typeof workspacePolicy.planId !== 'string' || !Number.isSafeInteger(workspacePolicy.planVersion)) {
      const error = new Error('Organization has no versioned workspace-plan selection to purchase.');
      error.statusCode = 409;
      error.code = 'SUBSCRIPTION_PLAN_SELECTION_MISSING';
      throw error;
    }
    return { planId: workspacePolicy.planId, workspacePlanVersion: workspacePolicy.planVersion, workspacePolicy };
  }

  async function resolveInventory(orgId) {
    const [workspaces, seatRows, addons] = await Promise.all([
      pool.query('SELECT id,industry FROM workspaces WHERE org_id=? ORDER BY id', [orgId]),
      pool.query("SELECT COUNT(*) AS seat_count FROM org_members WHERE org_id=? AND COALESCE(NULLIF(status,''),'Active')='Active'", [orgId]),
      pool.query("SELECT workspace_id,period_ends_at FROM billing_workspace_addons WHERE org_id=? AND status='active' AND workspace_id IS NOT NULL", [orgId]),
    ]);
    const ws = rowsOf(workspaces);
    const seatCount = Number(rowsOf(seatRows)[0]?.seat_count || 0);
    if (!Number.isSafeInteger(seatCount) || seatCount < 0) throw new Error('Organization seat inventory is invalid.');
    const now = Date.parse(clock.now());
    const separatelyBilled = new Set(rowsOf(addons)
      .filter((row) => row.period_ends_at == null || Date.parse(row.period_ends_at) > now)
      .map((row) => row.workspace_id));
    return inventoryFrom(ws, seatCount, separatelyBilled);
  }

  async function provisionInitialQuote({ orgId, requestKey = 'onboarding' }) {
    const org = await resolveOrg(orgId);
    if (!org) return null;
    const now = new Date(clock.now());
    if (!Number.isFinite(now.getTime())) throw new TypeError('Subscription clock returned an invalid timestamp.');
    const sourcePlanVersion = await resolvePlanVersion({
      workspacePlanId: org.planId,
      workspacePlanVersion: org.workspacePlanVersion,
      at: now.toISOString(),
    });
    if (!sourcePlanVersion || sourcePlanVersion.status !== 'published' || !sourcePlanVersion.planId
        || !Number.isSafeInteger(sourcePlanVersion.version)) {
      const error = new Error('Selected workspace plan has no published canonical billing version.');
      error.statusCode = 409;
      error.code = 'SUBSCRIPTION_PLAN_VERSION_UNAVAILABLE';
      throw error;
    }
    const inventory = await resolveInventory(orgId);
    const planCatalogService = { getVersion: async ({ planId, version }) => {
      if (planId !== sourcePlanVersion.planId || version !== sourcePlanVersion.version) return null;
      return sourcePlanVersion;
    } };
    const initialPurchase = createInitialPurchaseService({
      unitOfWork, planCatalogService, quoteRepository, subscriptionRepository, idSource, clock,
    });
    const validUntil = new Date(now.getTime() + quoteTtlSeconds(ttlOverride) * 1000).toISOString();
    const orgKey = crypto.createHash('sha256').update(orgId).digest('hex').slice(0, 24);
    const requestHash = crypto.createHash('sha256').update(String(requestKey)).digest('hex').slice(0, 24);
    const idempotencyKey = `subscription-initial-${orgKey}-${requestHash}`;
    return initialPurchase.provision({
      orgId, planId: sourcePlanVersion.planId, planVersion: sourcePlanVersion.version,
      inventory, validUntil,
      idempotencyKey,
      accessPolicy: { initialUnpaidAccess: policy.initialUnpaidAccess, billingTimeZone: policy.billingTimeZone },
    });
  }

  async function provisionFreeTrial({ orgId, days }) {
    if (!Number.isSafeInteger(days) || days < 1 || days > 15) throw Object.assign(new Error('Free trial duration must be from 1 to 15 days.'), { statusCode: 400, code: 'INVALID_TRIAL_DURATION' });
    const org = await resolveOrg(orgId);
    if (!org) return null;
    const now = new Date(clock.now());
    if (!Number.isFinite(now.getTime())) throw new TypeError('Subscription clock returned an invalid timestamp.');
    const planVersion = await resolvePlanVersion({ workspacePlanId: org.planId, workspacePlanVersion: org.workspacePlanVersion, at: now.toISOString() });
    if (!planVersion || planVersion.status !== 'published') throw Object.assign(new Error('Selected workspace plan has no published billing version for the trial.'), { statusCode: 409, code: 'SUBSCRIPTION_PLAN_VERSION_UNAVAILABLE' });
    const endsAt = new Date(now.getTime() + days * 86400000).toISOString();
    const periodId = idSource.newId('billing-trial-period');
    const opId = `subscription-trial-${crypto.createHash('sha256').update(orgId).digest('hex').slice(0, 40)}`;
    const requestFingerprint = `sha256:${crypto.createHash('sha256').update(JSON.stringify({ orgId, days, planId: planVersion.planId, planVersion: planVersion.version })).digest('hex')}`;
    await unitOfWork.runFinancial({ orgId, operationId: opId, requestFingerprint, callback: async (tx) => {
      const existing = await subscriptionRepository.getOrganizationSubscription(tx, { orgId, forUpdate: true });
      if (existing) return { periodId: existing.currentPeriodId, alreadyProvisioned: true };
      await subscriptionRepository.createOrganizationSubscription(tx, { orgId, lifecycleStatus: 'active', currentPlanId: planVersion.planId,
        currentPlanVersion: planVersion.version, billingAccessState: 'operational', billingSuspensionCause: null,
        restrictionDeadline: endsAt, accessPolicy: { initialUnpaidAccess: 'billing_recovery', billingTimeZone: 'UTC' }, now: now.toISOString() });
      const terms = JSON.parse(JSON.stringify(planVersion.terms));
      const trialCreditAmount = { asset: terms.currency || 'INR', units: '20000', scale: 2 };
      terms.includedCredits = trialCreditAmount;
      const snapshot = { schemaVersion: 1, source: 'free_trial', trialDays: days, plan: { id: planVersion.planId, version: planVersion.version, terms }, terms: { ...terms, includedCredits: terms.includedCredits || { asset: 'INR', units: '0', scale: 2 } } };
      await tx.query(`INSERT INTO billing_periods (id,org_id,period_kind,starts_at,ends_at,anchor_at,terms_version,status,terms_snapshot_json,activated_at,closed_at,created_at,updated_at)
        VALUES (?,?, 'subscription',?,?,?,NULL,'active',?,?,NULL,?,?)`, [periodId, orgId, now.toISOString(), endsAt, endsAt, JSON.stringify(snapshot), now.toISOString(), now.toISOString(), now.toISOString()]);
      await tx.query(`UPDATE organization_subscriptions SET current_period_id=?,updated_at=? WHERE org_id=?`, [periodId, now.toISOString(), orgId]);
      const creditAccount = await creditRepository.ensureAccount(tx, { orgId, accountType: 'organization', ownerId: orgId,
        asset: trialCreditAmount.asset, scale: trialCreditAmount.scale, accountPurpose: 'pool', now: now.toISOString() });
      const clearingAccount = await creditRepository.ensureAccount(tx, { orgId, accountType: 'organization', ownerId: orgId,
        asset: trialCreditAmount.asset, scale: trialCreditAmount.scale, accountPurpose: 'funding_clearing', now: now.toISOString() });
      const grantId = idSource.newId('billing-trial-credit-grant');
      const grantPlan = planIssueGrant({ orgId, operationId: `${opId}:credits`, adminAccountId: creditAccount.id,
        fundingClearingAccountId: clearingAccount.id, actor: { type: 'system', id: 'free-trial-provisioner' }, now: now.toISOString(),
        reason: `Issue ₹200 free-trial credits for ${days} days`, grant: { id: grantId, kind: 'subscription', amount: trialCreditAmount,
          sourceType: 'promotion', sourceId: periodId, sourceEventKey: 'free-trial-200-inr-v1', periodId,
          accountScope: organizationScope(orgId), effectiveAt: now.toISOString(), expiresAt: endsAt } });
      await creditRepository.createGrant(tx, { orgId, grant: grantPlan.grant, now: now.toISOString() });
      await creditRepository.applyJournal(tx, { ...grantPlan.journal, positionDeltas: grantPlan.positionDeltas });
    } });
    return { periodId, startsAt: now.toISOString(), endsAt, days };
  }

  async function readInitialQuote(orgId) {
    const rows = rowsOf(await pool.query(
      `SELECT s.lifecycle_status,s.billing_access_state,s.current_plan_id,s.current_plan_version,
              q.id AS quote_id,q.status AS quote_status,q.version AS quote_version,q.total_units,q.asset,q.scale,
              q.valid_until,q.created_at,q.terms_snapshot_json
         FROM organization_subscriptions s
         LEFT JOIN billing_subscription_period_links l ON l.org_id=s.org_id AND l.purpose='initial_purchase'
         LEFT JOIN billing_quotes q ON q.org_id=l.org_id AND q.id=l.quote_id AND q.quote_type='purchase'
        WHERE s.org_id=? ORDER BY q.created_at DESC,q.id DESC LIMIT 1`,
      [orgId],
    ));
    if (!rows.length) return null;
    const row = rows[0];
    const now = Date.parse(clock.now());
    const validUntil = row.valid_until == null ? null : new Date(row.valid_until).toISOString();
    const snapshot = row.quote_id == null ? null : objectValue(row.terms_snapshot_json, 'subscription quote snapshot');
    const expired = validUntil == null || !Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= now;
    return Object.freeze({
      subscription: Object.freeze({ lifecycleStatus: row.lifecycle_status, accessState: row.billing_access_state,
        planId: row.current_plan_id, planVersion: row.current_plan_version == null ? null : Number(row.current_plan_version) }),
      quote: row.quote_id == null ? null : Object.freeze({
        quoteId: row.quote_id, purpose: 'purchase', status: row.quote_status, version: Number(row.quote_version),
        paymentAmount: Object.freeze({ asset: row.asset, units: String(row.total_units), scale: Number(row.scale) }),
        includedCredits: snapshot.includedCredits, plan: snapshot.plan, inventory: snapshot.inventory,
        lines: snapshot.lines, subtotal: snapshot.subtotal, discounts: snapshot.discounts,
        totalTax: snapshot.totalTax, total: snapshot.total,
        createdAt: new Date(row.created_at).toISOString(), validUntil, expired,
        payable: !expired && ['draft', 'accepted'].includes(String(row.quote_status).toLowerCase()),
      }),
    });
  }

  return Object.freeze({ provisionInitialQuote, provisionFreeTrial, readInitialQuote });
}

module.exports = { createSubscriptionPurchaseComposition, quoteTtlSeconds, inventoryFrom };
