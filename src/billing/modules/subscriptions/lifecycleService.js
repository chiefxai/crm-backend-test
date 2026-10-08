'use strict';

const { assertTransactionContext } = require('../../kernel/transactionContext');
const { validateId } = require('../../kernel/scope');
const { normalizePlanTerms } = require('../catalog/terms');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');
const {
  previewSubscriptionPeriod,
  previewEarlyRenewal,
  previewPostpaidPeriod,
  evaluatePeriodActivation,
} = require('./periodMath');

const ISO_INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/;
const ACTIVE_STATUSES = new Set(['active']);
const OPEN_STATUSES = new Set(['scheduled', 'active']);

function instant(value, label) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== 'string' || !ISO_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, `${label} must be an ISO-8601 timestamp with an explicit timezone.`);
  }
  return new Date(value).toISOString();
}

function assertOrgTx(tx, orgId) {
  assertTransactionContext(tx);
  if (tx.metadata?.orgId !== orgId) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Transaction organization does not match the requested organization.');
  }
}

function requiredId(value, name) {
  try { return validateId(value, name); }
  catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, cause.message); }
}

function assertNoOverlap(period, existing) {
  const start = Date.parse(period.startsAt);
  const end = Date.parse(period.endsAt);
  const conflict = existing.find((item) => OPEN_STATUSES.has(String(item.status).toLowerCase())
    && Date.parse(item.startAt) < end && Date.parse(item.endAt) > start);
  if (conflict) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Subscription period overlaps an existing scheduled or active period.', {
      details: { conflictingPeriodId: conflict.id },
    });
  }
}

function assertStatus(period, expected) {
  if (!period) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Billing period does not exist.');
  if (String(period.status).toLowerCase() !== expected) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, `Billing period must be ${expected} before this transition.`, {
      details: { periodId: period.id, status: period.status, expectedStatus: expected },
    });
  }
}

function createSubscriptionLifecycleService({ unitOfWork, periodRepository, allocationRepository, idSource, clock }) {
  if (allocationRepository && typeof allocationRepository.getRuleVersion !== 'function') {
    throw new TypeError('Allocation policy repository must provide getRuleVersion().');
  }
  if (typeof unitOfWork?.runFinancial !== 'function'
    || typeof periodRepository?.getPeriod !== 'function'
    || typeof periodRepository?.getCurrentPeriodForUpdate !== 'function'
    || typeof periodRepository?.insertScheduledPeriod !== 'function'
    || typeof periodRepository?.transitionPeriod !== 'function'
    || typeof periodRepository?.listPeriods !== 'function'
    || typeof periodRepository?.getBillingAccount !== 'function'
    || typeof periodRepository?.getApprovedSubscriptionPurchase !== 'function'
    || typeof periodRepository?.linkApprovedSubscriptionPayment !== 'function'
    || typeof periodRepository?.assertPeriodFunded !== 'function'
    || typeof idSource?.newId !== 'function'
    || typeof clock?.now !== 'function') {
    throw new TypeError('Subscription lifecycle requires UnitOfWork, period repository, ID source, and clock ports.');
  }

  // Payment approval invokes this helper inside its existing financial UoW so
  // approval, period scheduling, fulfillment and outbox event commit together.
  async function schedulePaidRenewalInTransaction({ tx, orgId, paymentRequestId, currentPeriodId }) {
    orgId = requiredId(orgId, 'orgId');
    paymentRequestId = requiredId(paymentRequestId, 'paymentRequestId');
    assertOrgTx(tx, orgId);
    const purchase = await periodRepository.getApprovedSubscriptionPurchase(tx, { orgId, paymentRequestId });
    if (!purchase?.termsSnapshot || !purchase.effectiveTerms) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Approved subscription purchase is missing its immutable quote terms snapshot.', { retryable: true });
    }
    const terms = normalizePlanTerms(purchase.effectiveTerms);
    const paidAt = instant(purchase.purchaseAt, 'approved purchase timestamp');
    const allocationPolicy = allocationRepository
      ? await allocationRepository.getRuleVersion(tx, { orgId, grantKind: 'subscription', at: paidAt })
      : null;
    const account = await periodRepository.getBillingAccount(tx, { orgId });
    const timeZone = account?.timezone || 'UTC';
    const currentPeriod = currentPeriodId
      ? await periodRepository.getPeriod(tx, { orgId, periodId: requiredId(currentPeriodId, 'currentPeriodId') })
      : await periodRepository.getCurrentPeriodForUpdate(tx, { orgId, at: paidAt });
    const periodHistory = currentPeriod ? [] : await periodRepository.listPeriods(tx, {
      orgId, from: new Date(Date.parse(paidAt) - 100 * 366 * 86400000).toISOString(), to: paidAt, limit: 500,
    });
    const previousSubscription = currentPeriod || periodHistory
      .filter((item) => item.periodKind === 'subscription' && Date.parse(item.endAt) <= Date.parse(paidAt))
      .sort((a, b) => Date.parse(b.endAt) - Date.parse(a.endAt))[0] || null;
    const preview = previousSubscription && ACTIVE_STATUSES.has(String(previousSubscription.status).toLowerCase())
      && Date.parse(paidAt) < Date.parse(previousSubscription.endAt)
      ? previewEarlyRenewal({
        currentPeriod: { startsAt: previousSubscription.startAt, endsAt: previousSubscription.endAt, anchorAt: previousSubscription.anchorAt },
        purchasedAt: paidAt, intervalUnit: terms.billingInterval.unit, intervalCount: terms.billingInterval.count, timeZone,
      })
      : previewSubscriptionPeriod({
        purchasedAt: paidAt, intervalUnit: terms.billingInterval.unit, intervalCount: terms.billingInterval.count,
        previousPeriod: previousSubscription ? { startsAt: previousSubscription.startAt, endsAt: previousSubscription.endAt, anchorAt: previousSubscription.anchorAt } : undefined,
        timeZone, now: clock.now(),
      });
    const now = instant(clock.now(), 'clock.now()');
    const period = {
      id: requiredId(idSource.newId('billing-period'), 'periodId'), orgId, periodKind: 'subscription',
      startAt: preview.startsAt, endAt: preview.endsAt, anchorAt: preview.anchorAt,
      termsVersion: purchase.termsVersion ?? null, status: 'scheduled',
      termsSnapshot: {
        schemaVersion: 1, source: 'approved_subscription_quote', paymentRequestId: purchase.paymentRequestId,
        quoteId: purchase.quoteId, quoteType: purchase.quoteType, plan: purchase.termsSnapshot.plan,
        termsVersion: purchase.termsVersion ?? null, purchasedAt: paidAt, terms,
        allocationPolicy: allocationPolicy ? { grantKind: 'subscription', ruleVersionId: allocationPolicy.id, version: allocationPolicy.version } : null,
      }, createdAt: now, updatedAt: now,
    };
    const existing = await periodRepository.listPeriods(tx, {
      orgId, from: new Date(Date.parse(period.startAt) - 366 * 86400000).toISOString(),
      to: new Date(Date.parse(period.endAt) + 366 * 86400000).toISOString(), limit: 500,
    });
    assertNoOverlap(period, existing);
    const inserted = await periodRepository.insertScheduledPeriod(tx, period);
    await periodRepository.linkApprovedSubscriptionPayment(tx, { orgId, paymentRequestId, periodId: inserted.id, now });
    return Object.freeze({ ...inserted, renewalPreview: Object.freeze({ ...preview, lateRenewal: Boolean(preview.lateRenewal) }) });
  }

  async function schedulePaidRenewal({ orgId, operationId, requestFingerprint, paymentRequestId, currentPeriodId, expectedVersions }) {
    orgId = requiredId(orgId, 'orgId');
    paymentRequestId = requiredId(paymentRequestId, 'paymentRequestId');
    return unitOfWork.runFinancial({ orgId, operationId, requestFingerprint, expectedVersions, callback: async (tx) => {
      assertOrgTx(tx, orgId);
      if (typeof periodRepository.getApprovedSubscriptionPurchase !== 'function') {
        throw new TypeError('Period repository must provide the approved subscription purchase snapshot.');
      }
      const purchase = await periodRepository.getApprovedSubscriptionPurchase(tx, { orgId, paymentRequestId });
      if (!purchase?.termsSnapshot || !purchase.effectiveTerms) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Approved subscription purchase is missing its immutable quote terms snapshot.', { retryable: true });
      }
      // Purchased terms come from the approved immutable quote, never the
      // mutable current plan or the gross payment amount.
      const terms = normalizePlanTerms(purchase.effectiveTerms);
      const paidAt = instant(purchase.purchaseAt, 'approved purchase timestamp');
      const allocationPolicy = allocationRepository
        ? await allocationRepository.getRuleVersion(tx, { orgId, grantKind: 'subscription', at: paidAt })
        : null;

      const account = await periodRepository.getBillingAccount?.(tx, { orgId });
      const timeZone = account?.timezone || 'UTC';
      const currentPeriod = currentPeriodId
        ? await periodRepository.getPeriod(tx, { orgId, periodId: requiredId(currentPeriodId, 'currentPeriodId') })
        : await periodRepository.getCurrentPeriodForUpdate(tx, { orgId, at: paidAt });
      const periodHistory = currentPeriod ? [] : await periodRepository.listPeriods(tx, {
        orgId,
        from: new Date(Date.parse(paidAt) - 100 * 366 * 86400000).toISOString(),
        to: paidAt,
        limit: 500,
      });
      const previousSubscription = currentPeriod || periodHistory
        .filter((item) => item.periodKind === 'subscription' && Date.parse(item.endAt) <= Date.parse(paidAt))
        .sort((a, b) => Date.parse(b.endAt) - Date.parse(a.endAt))[0] || null;
      let preview;
      if (previousSubscription && ACTIVE_STATUSES.has(String(previousSubscription.status).toLowerCase())
        && Date.parse(paidAt) < Date.parse(previousSubscription.endAt)) {
        preview = previewEarlyRenewal({
          currentPeriod: { startsAt: previousSubscription.startAt, endsAt: previousSubscription.endAt, anchorAt: previousSubscription.anchorAt },
          purchasedAt: paidAt,
          intervalUnit: terms.billingInterval.unit,
          intervalCount: terms.billingInterval.count,
          timeZone,
        });
      } else {
        preview = previewSubscriptionPeriod({
          purchasedAt: paidAt,
          intervalUnit: terms.billingInterval.unit,
          intervalCount: terms.billingInterval.count,
          previousPeriod: previousSubscription ? {
            startsAt: previousSubscription.startAt,
            endsAt: previousSubscription.endAt,
            anchorAt: previousSubscription.anchorAt,
          } : undefined,
          timeZone,
          now: clock.now(),
        });
      }

      const period = {
        id: requiredId(idSource.newId('billing-period'), 'periodId'),
        orgId,
        periodKind: 'subscription',
        startAt: preview.startsAt,
        endAt: preview.endsAt,
        anchorAt: preview.anchorAt,
        termsVersion: purchase.termsVersion ?? null,
        status: 'scheduled',
        termsSnapshot: {
          schemaVersion: 1,
          source: 'approved_subscription_quote',
          paymentRequestId: purchase.paymentRequestId,
          quoteId: purchase.quoteId,
          quoteType: purchase.quoteType,
          plan: purchase.termsSnapshot.plan,
          termsVersion: purchase.termsVersion ?? null,
          purchasedAt: paidAt,
          terms,
          allocationPolicy: allocationPolicy ? { grantKind: 'subscription', ruleVersionId: allocationPolicy.id, version: allocationPolicy.version } : null,
        },
        createdAt: instant(clock.now(), 'clock.now()'),
        updatedAt: instant(clock.now(), 'clock.now()'),
      };
      const existing = await periodRepository.listPeriods(tx, {
        orgId,
        from: new Date(Date.parse(period.startAt) - 366 * 86400000).toISOString(),
        to: new Date(Date.parse(period.endAt) + 366 * 86400000).toISOString(),
        limit: 500,
      });
      assertNoOverlap(period, existing);
      const inserted = await periodRepository.insertScheduledPeriod(tx, period);
      await periodRepository.linkApprovedSubscriptionPayment(tx, {
        orgId,
        paymentRequestId,
        periodId: inserted.id,
        now: instant(clock.now(), 'clock.now()'),
      });
      return Object.freeze({ ...inserted, renewalPreview: Object.freeze({ ...preview, lateRenewal: Boolean(preview.lateRenewal) }) });
    } });
  }

  async function activateScheduledPeriod({ orgId, operationId, requestFingerprint, periodId, paymentRequestId, at, expectedVersions }) {
    orgId = requiredId(orgId, 'orgId');
    periodId = requiredId(periodId, 'periodId');
    at = instant(at || clock.now(), 'at');
    return unitOfWork.runFinancial({ orgId, operationId, requestFingerprint, expectedVersions, callback: async (tx) => {
      assertOrgTx(tx, orgId);
      const period = await periodRepository.getPeriod(tx, { orgId, periodId });
      assertStatus(period, 'scheduled');
      if (period.periodKind !== 'subscription') {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Only a scheduled subscription period can use paid activation.');
      }
      const existing = await periodRepository.listPeriods(tx, {
        orgId,
        from: new Date(Date.parse(period.startAt) - 366 * 86400000).toISOString(),
        to: new Date(Date.parse(period.endAt) + 366 * 86400000).toISOString(),
        limit: 500,
      });
      await periodRepository.assertPeriodFunded(tx, {
        orgId, periodId, paymentRequestId: requiredId(paymentRequestId, 'paymentRequestId'),
      });
      const decision = evaluatePeriodActivation({
        period: { ...period, startsAt: period.startAt, endsAt: period.endAt },
        now: at,
        existingPeriods: existing.map((item) => ({ ...item, startsAt: item.startAt, endsAt: item.endAt })),
        funded: true,
      });
      if (!decision.eligible) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Scheduled period is not eligible for activation.', { details: { reason: decision.reason } });
      }
      return periodRepository.transitionPeriod(tx, {
        orgId, periodId, expectedStatus: 'scheduled', status: 'active',
        fields: { activatedAt: at, updatedAt: instant(clock.now(), 'clock.now()') }, fundingProof: { paymentRequestId },
      });
    } });
  }

  async function cancelScheduledPeriod({ orgId, operationId, requestFingerprint, periodId, at, expectedVersions }) {
    orgId = requiredId(orgId, 'orgId');
    periodId = requiredId(periodId, 'periodId');
    at = instant(at || clock.now(), 'at');
    return unitOfWork.runFinancial({ orgId, operationId, requestFingerprint, expectedVersions, callback: async (tx) => {
      assertOrgTx(tx, orgId);
      const period = await periodRepository.getPeriod(tx, { orgId, periodId });
      assertStatus(period, 'scheduled');
      return periodRepository.transitionPeriod(tx, {
        orgId, periodId, expectedStatus: 'scheduled', status: 'cancelled', fields: { closedAt: at, updatedAt: instant(clock.now(), 'clock.now()') },
      });
    } });
  }

  // A subscription is represented by its period chain. Cancelling renewal
  // preserves the paid active cycle and cancels future scheduled cycles.
  async function cancelSubscriptionRenewal({ orgId, operationId, requestFingerprint, currentPeriodId, at, expectedVersions }) {
    orgId = requiredId(orgId, 'orgId');
    currentPeriodId = requiredId(currentPeriodId, 'currentPeriodId');
    at = instant(at || clock.now(), 'at');
    return unitOfWork.runFinancial({ orgId, operationId, requestFingerprint, expectedVersions, callback: async (tx) => {
      assertOrgTx(tx, orgId);
      const current = await periodRepository.getPeriod(tx, { orgId, periodId: currentPeriodId });
      assertStatus(current, 'active');
      if (current.periodKind !== 'subscription') {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Only an active subscription period can cancel its renewal.');
      }
      const future = await periodRepository.listPeriods(tx, {
        orgId,
        from: current.endAt,
        to: new Date(Date.parse(current.endAt) + 100 * 366 * 86400000).toISOString(),
        limit: 500,
      });
      const cancelled = [];
      for (const period of future) {
        if (period.periodKind !== 'subscription' || period.status !== 'scheduled') continue;
        cancelled.push(await periodRepository.transitionPeriod(tx, {
          orgId,
          periodId: period.id,
          expectedStatus: 'scheduled',
          status: 'cancelled',
          fields: { closedAt: at, updatedAt: instant(clock.now(), 'clock.now()') },
        }));
      }
      return Object.freeze({ currentPeriod: current, cancelledPeriods: Object.freeze(cancelled) });
    } });
  }

  async function schedulePostpaidPeriod({ orgId, operationId, requestFingerprint, anchorAt, intervalUnit, intervalCount, timeZone, now, periodId, expectedVersions }) {
    orgId = requiredId(orgId, 'orgId');
    now = instant(now || clock.now(), 'now');
    return unitOfWork.runFinancial({ orgId, operationId, requestFingerprint, expectedVersions, callback: async (tx) => {
      assertOrgTx(tx, orgId);
      const account = await periodRepository.getBillingAccount?.(tx, { orgId });
      if (!account || account.fallbackMode !== 'postpaid' || !account.postpaidEligible) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.POSTPAID_DISABLED, 'Organization account is not enabled for postpaid periods.');
      }
      const current = await periodRepository.getCurrentPeriodForUpdate(tx, { orgId, at: now });
      if (current && ACTIVE_STATUSES.has(String(current.status).toLowerCase()) && current.periodKind === 'subscription') {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'A subscription period is active; a postpaid period cannot overlap it.');
      }
      if (current && ACTIVE_STATUSES.has(String(current.status).toLowerCase()) && current.periodKind === 'postpaid') return current;
      const history = current ? [] : await periodRepository.listPeriods(tx, {
        orgId,
        from: new Date(Date.parse(now) - 100 * 366 * 86400000).toISOString(),
        to: now,
        limit: 500,
      });
      const previousPostpaid = current?.periodKind === 'postpaid' ? current : history
        .filter((item) => item.periodKind === 'postpaid' && Date.parse(item.startAt) <= Date.parse(now))
        .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt))[0];
      const cadence = previousPostpaid?.termsSnapshot?.postpaidCadence;
      const persistedAnchor = previousPostpaid?.anchorAt || anchorAt;
      const persistedUnit = cadence?.unit || intervalUnit;
      const persistedCount = cadence?.count || intervalCount;
      if (!persistedAnchor || !persistedUnit || !persistedCount) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'First postpaid cycle requires an explicit anchor and interval from the configured postpaid policy.');
      }
      const resolvedAnchor = instant(persistedAnchor, 'postpaid anchorAt');
      const preview = previewPostpaidPeriod({
        anchorAt: resolvedAnchor,
        intervalUnit: persistedUnit,
        intervalCount: persistedCount,
        timeZone: timeZone || account.timezone || 'UTC',
        now,
      });
      const startAt = preview.startsAt;
      const endAt = preview.endsAt;
      const existing = await periodRepository.listPeriods(tx, {
        orgId,
        from: new Date(Date.parse(startAt) - 366 * 86400000).toISOString(),
        to: new Date(Date.parse(endAt) + 366 * 86400000).toISOString(),
        limit: 500,
      });
      const period = {
        id: requiredId(periodId || idSource.newId('billing-period'), 'periodId'),
        orgId,
        periodKind: 'postpaid',
        startAt,
        endAt,
        anchorAt: resolvedAnchor,
        termsVersion: null,
        status: 'scheduled',
        termsSnapshot: {
          schemaVersion: 1,
          source: 'organization_postpaid_policy',
          fallbackMode: account.fallbackMode,
          postpaidCadence: { unit: persistedUnit, count: persistedCount },
        },
        createdAt: instant(clock.now(), 'clock.now()'),
        updatedAt: instant(clock.now(), 'clock.now()'),
      };
      assertNoOverlap(period, existing);
      const inserted = await periodRepository.insertScheduledPeriod(tx, period);
      return periodRepository.transitionPeriod(tx, {
        orgId, periodId: inserted.id, expectedStatus: 'scheduled', status: 'active',
        fields: { activatedAt: now, updatedAt: instant(clock.now(), 'clock.now()') }, allowPostpaidActivation: true,
      });
    } });
  }

  async function getPeriod(tx, { orgId, periodId }) {
    orgId = requiredId(orgId, 'orgId');
    assertOrgTx(tx, orgId);
    return periodRepository.getPeriod(tx, { orgId, periodId: requiredId(periodId, 'periodId') });
  }

  async function listPeriods(tx, { orgId, from, to, limit = 100 }) {
    orgId = requiredId(orgId, 'orgId');
    assertOrgTx(tx, orgId);
    return periodRepository.listPeriods(tx, { orgId, from: instant(from, 'from'), to: instant(to, 'to'), limit });
  }

  function previewRenewal({ purchasedAt, terms, currentPeriod, timeZone = 'UTC', now = clock.now() }) {
    terms = normalizePlanTerms(terms);
    if (currentPeriod && String(currentPeriod.status).toLowerCase() === 'active' && Date.parse(purchasedAt) < Date.parse(currentPeriod.endAt)) {
      return previewEarlyRenewal({
        currentPeriod: { startsAt: currentPeriod.startAt, endsAt: currentPeriod.endAt, anchorAt: currentPeriod.anchorAt },
        purchasedAt,
        intervalUnit: terms.billingInterval.unit,
        intervalCount: terms.billingInterval.count,
        timeZone,
      });
    }
    return previewSubscriptionPeriod({
      purchasedAt,
      intervalUnit: terms.billingInterval.unit,
      intervalCount: terms.billingInterval.count,
      previousPeriod: currentPeriod ? { startsAt: currentPeriod.startAt, endsAt: currentPeriod.endAt, anchorAt: currentPeriod.anchorAt } : undefined,
      timeZone,
      now,
    });
  }

  return Object.freeze({
    schedulePaidRenewal,
    schedulePaidRenewalInTransaction,
    activateScheduledPeriod,
    cancelScheduledPeriod,
    cancelSubscriptionRenewal,
    schedulePostpaidPeriod,
    getPeriod,
    listPeriods,
    previewRenewal,
  });
}

module.exports = { createSubscriptionLifecycleService, assertNoOverlap };
