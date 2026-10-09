'use strict';

const crypto = require('node:crypto');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');
const { organizationScope, validateId } = require('../../kernel/scope');
const { validateAmount } = require('../../kernel/amount');
const { planIssueGrant } = require('../credits/domain');
const { evaluatePeriodActivation } = require('./periodMath');

function stableId(prefix, value) { return `${prefix}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 40)}`; }
function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

function createPeriodActivationService({ unitOfWork, periodRepository, creditRepository, outbox, clock } = {}) {
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Period activation requires UnitOfWork.runFinancial().');
  for (const method of ['getPeriod', 'getPeriodFunding', 'listPeriods', 'transitionPeriod']) {
    if (typeof periodRepository?.[method] !== 'function') throw new TypeError(`Period repository requires ${method}().`);
  }
  for (const method of ['ensureAccount', 'createGrant', 'applyJournal']) {
    if (typeof creditRepository?.[method] !== 'function') throw new TypeError(`Credit repository requires ${method}().`);
  }
  if (typeof outbox?.enqueue !== 'function') throw new TypeError('Period activation requires a transactional outbox.');
  if (typeof clock?.now !== 'function') throw new TypeError('Period activation requires a clock.');

  async function activatePeriod({ orgId, periodId, now = clock.now() } = {}) {
    validateId(orgId, 'orgId'); validateId(periodId, 'periodId');
    const operationId = stableId('activate-period', `${orgId}\0${periodId}`);
    const requestFingerprint = fingerprint({ orgId, periodId, action: 'activate_due_subscription_period_v1' });
    return unitOfWork.runFinancial({ orgId, operationId, requestFingerprint, callback: async (tx) => {
      const period = await periodRepository.getPeriod(tx, { orgId, periodId });
      if (!period) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Billing period does not exist.');
      if (period.periodKind !== 'subscription') throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Only subscription periods can be activated by paid subscription lifecycle.');
      if (period.status !== 'scheduled') throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Billing period is not scheduled for activation.', { details: { status: period.status } });
      const funding = await periodRepository.getPeriodFunding(tx, { orgId, periodId });
      if (!funding) throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_NOT_FUNDED, 'A due subscription period requires an approved payment fulfillment.');
      const existing = await periodRepository.listPeriods(tx, {
        orgId, from: new Date(Date.parse(period.startAt) - 366 * 86400000).toISOString(),
        to: new Date(Date.parse(period.endAt) + 366 * 86400000).toISOString(), limit: 500,
      });
      const decision = evaluatePeriodActivation({
        period: { ...period, startsAt: period.startAt, endsAt: period.endAt }, now,
        existingPeriods: existing.map((item) => ({ ...item, startsAt: item.startAt, endsAt: item.endAt })), funded: true,
      });
      if (!decision.eligible) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.PERIOD_INVALID, 'Scheduled period is not eligible for activation.', { details: { reason: decision.reason } });
      }

      const activePeriod = await periodRepository.transitionPeriod(tx, {
        orgId, periodId, expectedStatus: 'scheduled', status: 'active',
        fields: { activatedAt: now, updatedAt: clock.now() }, fundingProof: { paymentRequestId: funding.paymentRequestId },
      });

      const creditAmount = validateAmount(period.termsSnapshot?.terms?.includedCredits);
      let grantResult = null;
      if (BigInt(creditAmount.units) > 0n) {
        const adminScope = organizationScope(orgId);
        const adminAccount = await creditRepository.ensureAccount(tx, {
          orgId, accountType: 'organization', ownerId: orgId, asset: creditAmount.asset, scale: creditAmount.scale,
          accountPurpose: 'pool', now,
        });
        const clearingAccount = await creditRepository.ensureAccount(tx, {
          orgId, accountType: 'organization', ownerId: orgId, asset: creditAmount.asset, scale: creditAmount.scale,
          accountPurpose: 'funding_clearing', now,
        });
        const grantId = stableId('subscription-grant', `${orgId}\0${periodId}`);
        const grantPlan = planIssueGrant({
          orgId, operationId: `${operationId}:grant`, adminAccountId: adminAccount.id,
          fundingClearingAccountId: clearingAccount.id, actor: { type: 'system', id: 'billing-lifecycle' }, now,
          reason: `Fund approved subscription period ${periodId}`,
          grant: {
            id: grantId, kind: 'subscription', amount: creditAmount,
            sourceType: 'subscription_period', sourceId: periodId, sourceEventKey: 'included-credits-v1',
            periodId, paymentRequestId: funding.paymentRequestId, accountScope: adminScope,
            effectiveAt: period.startAt, expiresAt: period.endAt,
          },
        });
        await creditRepository.createGrant(tx, { orgId, grant: grantPlan.grant, now });
        const journal = await creditRepository.applyJournal(tx, { ...grantPlan.journal, positionDeltas: grantPlan.positionDeltas });
        grantResult = Object.freeze({ grantId, amount: creditAmount, effectiveAt: period.startAt, expiresAt: period.endAt, journalId: journal.journalId });
      }

      const occurredAt = new Date(now).toISOString();
      const correlationId = operationId;
      const events = [{
        eventId: stableId('billing-event', `${orgId}\0period-activated\0${periodId}`),
        eventType: 'SubscriptionPeriodActivated.v1', schemaVersion: 1, operationId, orgId,
        aggregateType: 'BillingPeriod', aggregateId: periodId, aggregateVersion: 1,
        occurredAt, correlationId,
        payload: { periodId, paymentRequestId: funding.paymentRequestId, grant: grantResult, allocationPolicy: period.termsSnapshot?.allocationPolicy || null },
      }];
      if (grantResult && period.termsSnapshot?.allocationPolicy?.ruleVersionId && Number.isSafeInteger(period.termsSnapshot.allocationPolicy.version) && period.termsSnapshot.allocationPolicy.version > 0) {
        events.push({
          eventId: stableId('billing-event', `${orgId}\0allocation-requested\0${periodId}`),
          eventType: 'CreditGrantAllocationRequested.v1', schemaVersion: 1, operationId, orgId,
          aggregateType: 'CreditGrant', aggregateId: grantResult.grantId, aggregateVersion: 1,
          occurredAt, correlationId,
          payload: { periodId, grantId: grantResult.grantId, grantKind: 'subscription', ruleVersionId: period.termsSnapshot.allocationPolicy.ruleVersionId, ruleVersion: period.termsSnapshot.allocationPolicy.version },
        });
      }
      await outbox.enqueue(tx, { events });
      return Object.freeze({ period: activePeriod, funding, grant: grantResult, events: events.map((event) => event.eventId) });
    } });
  }

  return Object.freeze({ activatePeriod });
}

module.exports = { createPeriodActivationService, stableLifecycleId: stableId };
