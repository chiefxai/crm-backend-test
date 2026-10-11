'use strict';

const crypto = require('node:crypto');
const { validateId } = require('../../kernel/scope');
const { composeSubscriptionQuote } = require('../catalog/subscriptionQuoteComposition');

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fingerprint(value) {
  return `sha256:${crypto.createHash('sha256').update(stable(value)).digest('hex')}`;
}
function asIso(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp.`);
  return date.toISOString();
}

/**
 * Atomically creates the organization's onboarding subscription state, first
 * immutable purchase quote and awaiting-payment linkage. Call only after the
 * organization billing account exists; organization creation remains owned by
 * platform/organization setup composition. Payment proof and review continue
 * through the existing payment submission and decision services.
 */
function createInitialPurchaseService({ unitOfWork, planCatalogService, quoteRepository, subscriptionRepository, idSource, clock }) {
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Initial purchase service requires a billing UnitOfWork.');
  if (typeof planCatalogService?.getVersion !== 'function') throw new TypeError('Initial purchase service requires planCatalogService.getVersion().');
  if (typeof quoteRepository?.getByIdempotencyKey !== 'function' || typeof quoteRepository?.create !== 'function') {
    throw new TypeError('Initial purchase service requires a transaction-bound subscription quote repository.');
  }
  if (typeof subscriptionRepository?.getOrganizationSubscription !== 'function'
      || typeof subscriptionRepository?.createOrganizationSubscription !== 'function'
      || typeof subscriptionRepository?.linkPeriod !== 'function') {
    throw new TypeError('Initial purchase service requires subscription persistence methods.');
  }
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Initial purchase service requires ID and clock ports.');

  return Object.freeze({
    async provision({ orgId, planId, planVersion, inventory, validUntil, accessPolicy, idempotencyKey } = {}) {
      orgId = validateId(orgId, 'orgId');
      planId = validateId(planId, 'planId');
      if (!Number.isSafeInteger(planVersion) || planVersion < 1) throw new TypeError('planVersion must be a positive safe integer.');
      if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) throw new TypeError('inventory is required.');
      if (!accessPolicy || typeof accessPolicy !== 'object' || Array.isArray(accessPolicy)
          || accessPolicy.initialUnpaidAccess !== 'billing_recovery') {
        throw new TypeError('accessPolicy must explicitly set initialUnpaidAccess to billing_recovery.');
      }
      idempotencyKey = validateId(idempotencyKey || `subscription-initial-${orgId}`, 'idempotencyKey');
      const catalogVersion = await planCatalogService.getVersion({ planId, version: planVersion });
      if (!catalogVersion) throw Object.assign(new Error('Selected billing plan version was not found.'), { code: 'NOT_FOUND' });
      const now = asIso(clock.now(), 'clock.now()');
      validUntil = asIso(validUntil, 'validUntil');
      const quoteId = idSource.newId('billing-subscription-purchase-quote');
      const quote = composeSubscriptionQuote({
        planVersion: catalogVersion, purpose: 'purchase', orgId, quoteId, version: 1,
        inventory, createdAt: now, validUntil,
      });
      const requestFingerprint = fingerprint({ orgId, planId, planVersion, inventory, accessPolicy, idempotencyKey });
      const operationId = `subscription-initial-${crypto.createHash('sha256').update(`${orgId}\0${idempotencyKey}`).digest('hex').slice(0, 40)}`;

      return unitOfWork.runFinancial({ orgId, operationId, requestFingerprint, callback: async (tx) => {
        if (tx.metadata?.orgId !== orgId) throw new TypeError('Initial purchase transaction organization mismatch.');
        const existingSubscription = await subscriptionRepository.getOrganizationSubscription(tx, { orgId, forUpdate: true });
        if (existingSubscription && (existingSubscription.lifecycleStatus !== 'onboarding'
            || existingSubscription.currentPlanId !== planId || existingSubscription.currentPlanVersion !== planVersion)) {
          throw Object.assign(new Error('An organization subscription is already initialized.'), { code: 'CONFLICT' });
        }
        const existingQuote = await quoteRepository.getByIdempotencyKey(tx, { orgId, idempotencyKey, forUpdate: true });
        if (existingQuote) {
          throw Object.assign(new Error('An initial purchase quote exists without subscription onboarding state.'), { code: 'RETRYABLE_STORAGE' });
        }
        if (!existingSubscription) await subscriptionRepository.createOrganizationSubscription(tx, {
          orgId, lifecycleStatus: 'onboarding', currentPlanId: planId, currentPlanVersion: planVersion,
          billingAccessState: 'billing_recovery', billingSuspensionCause: 'initial_subscription_unpaid',
          restrictionDeadline: null, accessPolicy, now,
        });
        const persistedQuote = await quoteRepository.create(tx, { orgId, id: quoteId, idempotencyKey, quote });
        const linkage = await subscriptionRepository.linkPeriod(tx, {
          id: idSource.newId('billing-subscription-period-link'), orgId, periodId: null,
          quoteId, paymentRequestId: null, purpose: 'initial_purchase', periodState: 'awaiting_payment',
          planId, planVersion, effectiveAt: null, supersedesPeriodId: null, now,
        });
        return Object.freeze({
          orgId, lifecycleStatus: 'onboarding', billingAccessState: 'billing_recovery',
          quoteId, quoteStatus: persistedQuote.status, quoteVersion: persistedQuote.version,
          paymentAmount: quote.total, includedCredits: quote.includedCredits,
          validUntil: quote.validUntil, plan: quote.plan, inventory: quote.inventory,
          periodLinkId: linkage.id, periodState: linkage.periodState,
        });
      } });
    },
  });
}

module.exports = { createInitialPurchaseService, initialPurchaseFingerprint: fingerprint };
