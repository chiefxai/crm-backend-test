'use strict';

const crypto = require('node:crypto');
const { validatePaymentDecision } = require('../../contracts/commands');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');
const { validateAmount } = require('../../kernel/amount');
const { planIssueGrant } = require('../credits/domain');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(canonical(value)).digest('hex')}`; }
function mismatch(message, details) { throw new BillingDomainError(DOMAIN_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH, message, { details }); }

function topupGrantAmount(request) {
  const quote = request.quote;
  if (!quote || quote.type !== 'topup' || quote.status !== 'accepted' || quote.paidAt) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Top-up approval requires an unpaid, accepted top-up quote.');
  }
  let grant;
  try { grant = validateAmount(quote.snapshot?.topupCredits); }
  catch (cause) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Top-up quote is missing its explicit immutable credit grant amount.', { retryable: true, details: { cause: cause.message } });
  }
  if (BigInt(grant.units) <= 0n) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Top-up quote grant amount must be greater than zero.', { retryable: true });
  return grant;
}

function createPaymentDecisionService({
  unitOfWork, repository, creditRepository, periodLifecycle, invoiceRepository, outbox, idSource, clock, authorizeDecision,
} = {}) {
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Payment decision service requires the billing UnitOfWork.');
  for (const method of ['getForUpdate', 'saveDecision', 'markQuotePaid', 'createFulfillment']) {
    if (typeof repository?.[method] !== 'function') throw new TypeError(`Payment decision repository requires ${method}().`);
  }
  for (const method of ['ensureAccount', 'createGrant', 'applyJournal']) {
    if (typeof creditRepository?.[method] !== 'function') throw new TypeError(`Payment decision service requires credit repository ${method}().`);
  }
  if (typeof periodLifecycle?.schedulePaidRenewalInTransaction !== 'function') throw new TypeError('Payment decision service requires transaction-scoped subscription period scheduling.');
  if (typeof outbox?.enqueue !== 'function') throw new TypeError('Payment decision service requires a transactional outbox.');
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Payment decision service requires an ID source and clock.');
  if (typeof authorizeDecision !== 'function') throw new TypeError('Payment decision service requires platform decision authorization.');

  async function issueTopup(tx, request, actor, operationId, now) {
    const amount = topupGrantAmount(request);
    const accountArgs = { orgId: request.orgId, accountType: 'organization', ownerId: request.orgId, asset: amount.asset, scale: amount.scale, now };
    const adminAccount = await creditRepository.ensureAccount(tx, { ...accountArgs, accountPurpose: 'pool' });
    const clearingAccount = await creditRepository.ensureAccount(tx, { ...accountArgs, accountPurpose: 'funding_clearing' });
    if (adminAccount.id === clearingAccount.id) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Admin pool and funding clearing accounts must be separate.');
    const grantId = idSource.newId('billing-credit-grant');
    const plan = planIssueGrant({
      orgId: request.orgId, operationId, adminAccountId: adminAccount.id,
      fundingClearingAccountId: clearingAccount.id, actor, now,
      reason: `Approved top-up payment ${request.id}`,
      grant: {
        id: grantId, kind: 'topup', amount, sourceType: 'payment_request', sourceId: request.id,
        sourceEventKey: 'approved-topup-credit-v1', accountScope: { orgId: request.orgId, ownerType: 'organization', ownerId: request.orgId },
        effectiveAt: now, expiresAt: null, paymentRequestId: request.id,
      },
    });
    await creditRepository.createGrant(tx, { orgId: request.orgId, grant: plan.grant, now });
    const journal = await creditRepository.applyJournal(tx, { ...plan.journal, positionDeltas: plan.positionDeltas });
    const fulfillment = await repository.createFulfillment(tx, {
      orgId: request.orgId, paymentRequestId: request.id, fulfillmentKind: 'topup_credit_grant',
      targetId: grantId, result: { grantId, creditAmount: amount, status: 'active' }, now,
    });
    return Object.freeze({ status: 'active', grantId, creditAmount: amount, journalId: journal.journalId, fulfillmentId: fulfillment.id });
  }

  return Object.freeze({
    async decide({ command, trustedContext } = {}) {
      const decision = validatePaymentDecision(command, trustedContext);
      const allowed = await authorizeDecision({ actor: decision.context.actor, orgId: decision.orgId, decision: decision.decision, paymentRequestId: decision.paymentRequestId });
      if (allowed !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to decide organization payment requests.');
      const requestFingerprint = fingerprint({
        orgId: decision.orgId, paymentRequestId: decision.paymentRequestId, decision: decision.decision,
        reason: decision.reason || null, receivedAmount: decision.receivedAmount || null,
        expectedVersion: decision.expectedVersion, actorId: decision.context.actor.id,
      });
      const now = clock.now();
      return unitOfWork.runFinancial({
        orgId: decision.orgId, operationId: decision.context.operationId, requestFingerprint,
        expectedVersions: decision.context.expectedVersions,
        callback: async (tx) => {
          const request = await repository.getForUpdate(tx, { orgId: decision.orgId, paymentRequestId: decision.paymentRequestId });
          if (!request) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Payment request was not found for this organization.');
          if (request.version !== decision.expectedVersion) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Payment request version is stale.', { details: { expectedVersion: decision.expectedVersion, actualVersion: request.version } });
          if (request.status !== 'pending_verification') throw new BillingDomainError(DOMAIN_ERROR_CODES.PAYMENT_NOT_PENDING, 'Only pending payment requests can receive a decision.', { details: { status: request.status } });
          if (decision.decision === 'approve') {
            if (!decision.receivedAmount || decision.receivedAmount.asset !== request.expectedAmount.asset
              || decision.receivedAmount.scale !== request.expectedAmount.scale
              || BigInt(decision.receivedAmount.units) !== BigInt(request.expectedAmount.units)) {
              mismatch('Received amount must exactly match the submitted expected amount before approval.', {
                expectedAmount: request.expectedAmount, receivedAmount: decision.receivedAmount || null,
              });
            }
            if (request.purpose === 'invoice') {
              if (typeof invoiceRepository?.applyPayment !== 'function') throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Invoice payment fulfillment is not configured.');
            } else {
              if (!request.quote || request.quote.status !== 'accepted' || request.quote.paidAt
                || request.quote.amount.asset !== request.expectedAmount.asset || request.quote.amount.scale !== request.expectedAmount.scale
                || BigInt(request.quote.amount.units) !== BigInt(request.expectedAmount.units)) {
                throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'The accepted quote is stale, already paid, or no longer matches the submitted payment.', { details: { quoteId: request.quoteId } });
              }
              await repository.markQuotePaid(tx, { orgId: request.orgId, quoteId: request.quoteId, now });
            }
          }

          const saved = await repository.saveDecision(tx, {
            request, expectedVersion: decision.expectedVersion, decision: decision.decision,
            reason: decision.reason || null, receivedAmount: decision.receivedAmount || null,
            actorId: decision.context.actor.id, now,
          });
          let funding = null;
          if (decision.decision === 'approve' && request.purpose === 'subscription') {
            funding = await periodLifecycle.schedulePaidRenewalInTransaction({
              tx, orgId: request.orgId, paymentRequestId: request.id,
            });
            funding = Object.freeze({ status: 'scheduled', periodId: funding.id, startsAt: funding.startAt, endsAt: funding.endAt });
          } else if (decision.decision === 'approve' && request.purpose === 'topup') {
            funding = await issueTopup(tx, request, decision.context.actor, decision.context.operationId, now);
          } else if (decision.decision === 'approve' && request.purpose === 'invoice') {
            const applied = await invoiceRepository.applyPayment(tx, { orgId: request.orgId, invoiceId: request.invoiceId,
              paymentRequestId: request.id, amount: decision.receivedAmount, now });
            const fulfillment = await repository.createFulfillment(tx, { orgId: request.orgId, paymentRequestId: request.id,
              fulfillmentKind: 'invoice_payment', targetId: request.invoiceId,
              result: { invoiceId: request.invoiceId, paymentId: applied.paymentId, status: applied.invoice.status }, now });
            funding = Object.freeze({ status: applied.invoice.status, invoiceId: request.invoiceId, paymentId: applied.paymentId, fulfillmentId: fulfillment.id });
          }

          const event = {
            eventId: idSource.newId('billing-event'),
            eventType: decision.decision === 'approve' ? 'PaymentConfirmed.v1' : 'PaymentDecisionRecorded.v1',
            schemaVersion: 1, operationId: decision.context.operationId, orgId: request.orgId,
            aggregateType: 'PaymentRequest', aggregateId: request.id, aggregateVersion: saved.requestVersionAfter,
            occurredAt: now, correlationId: decision.context.correlationId || decision.context.operationId,
            causationId: decision.context.causationId,
            payload: {
              paymentRequestId: request.id, purpose: request.purpose,
              decision: decision.decision, status: saved.status, reason: decision.reason || null,
              expectedAmount: request.expectedAmount, receivedAmount: decision.receivedAmount || null,
              creditState: funding?.status || null, funding: funding || null,
            },
          };
          await outbox.enqueue(tx, { events: [event] });
          return Object.freeze({ paymentRequestId: request.id, status: saved.status, decision: saved, funding, eventId: event.eventId });
        },
      });
    },
  });
}

module.exports = { createPaymentDecisionService, topupGrantAmount, fingerprint };
