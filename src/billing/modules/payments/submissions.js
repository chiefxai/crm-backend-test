'use strict';

const crypto = require('node:crypto');
const { validatePaymentSubmission } = require('../../contracts/commands');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');
const { validateId } = require('../../kernel/scope');
const { validateProof, normalizeReference, validateQuoteForSubmission } = require('./domain');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fingerprint(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function createPaymentSubmissionService({ unitOfWork, repository, proofStorage, idSource, clock, authorizeSubmission, authorizeReceipt } = {}) {
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Payment submission service requires the billing UnitOfWork.');
  for (const method of ['create', 'resubmit', 'getReceiptReference']) {
    if (typeof repository?.[method] !== 'function') throw new TypeError(`Payment submission repository requires ${method}().`);
  }
  for (const method of ['put', 'signedDownload']) {
    if (typeof proofStorage?.[method] !== 'function') throw new TypeError(`Payment proof storage requires ${method}().`);
  }
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Payment submission service requires idSource and clock.');
  if (typeof authorizeSubmission !== 'function') throw new TypeError('Payment submission service requires an explicit submission authorization policy.');
  if (typeof authorizeReceipt !== 'function') throw new TypeError('Payment submission service requires an explicit receipt authorization policy.');

  return Object.freeze({
    async submit({ command, trustedContext, proofFile } = {}) {
      const validated = validatePaymentSubmission(command, trustedContext);
      const authorized = await authorizeSubmission({
        actor: validated.context.actor, orgId: validated.orgId, purpose: validated.purpose,
        quoteId: validated.quoteId || null, invoiceId: validated.invoiceId || null,
        paymentRequestId: validated.paymentRequestId || null,
      });
      if (authorized !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to submit payment for this organization.');
      if (validated.receiptKey) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Receipt object keys are assigned by the server and cannot be supplied by a client.');
      if (BigInt(validated.expectedAmount.units) <= 0n) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_AMOUNT, 'Payment amount must be greater than zero.');
      if (!validated.quoteId && !validated.invoiceId) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Payment must be attached to its matching quote or invoice.');
      const proof = validateProof(proofFile);
      const reference = normalizeReference(validated.paymentReference);
      if (!reference) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Payment reference cannot be empty.');
      const orgId = validated.orgId;
      const operationId = validated.context.operationId;
      const requestFingerprint = fingerprint({
        orgId, purpose: validated.purpose, expectedAmount: validated.expectedAmount,
        paymentReference: reference, quoteId: validated.quoteId || null,
        invoiceId: validated.invoiceId || null, paymentRequestId: validated.paymentRequestId || null, payerNote: validated.payerNote || null,
        actorId: validated.context.actor.id, proofSha256: proof.sha256,
      });
      // Identical retries reuse one private object. A conflicting payload gets
      // a different staging key, so cleanup cannot delete a prior valid proof.
      const proofReference = crypto.createHash('sha256').update(`${orgId}:${operationId}:${requestFingerprint}`).digest('hex');
      const proofKey = await proofStorage.put({ orgId, paymentRequestId: proofReference, proof });
      const now = clock.now();
      return unitOfWork.runFinancial({
          orgId, operationId, requestFingerprint,
          expectedVersions: validated.context.expectedVersions,
          callback: async (tx) => {
            const record = {
              id: validated.paymentRequestId || idSource.newId('billing-payment-request'), orgId, purpose: validated.purpose,
              quoteId: validated.quoteId || null, invoiceId: validated.invoiceId || null,
              expectedAmount: validated.expectedAmount, paymentReference: reference,
              proofObjectKey: proofKey, proof, idempotencyKey: operationId,
              actorId: validated.context.actor.id, payerNote: validated.payerNote || null, now,
              validateQuote: (quote) => validateQuoteForSubmission({ purpose: validated.purpose, quote, amount: validated.expectedAmount, now }),
            };
            return validated.paymentRequestId
              ? repository.resubmit(tx, { ...record, paymentRequestId: validated.paymentRequestId })
              : repository.create(tx, record);
          },
        });
    },

    async createReceiptDownload({ orgId, paymentRequestId, actor, expiresIn = 120 } = {}) {
      validateId(orgId, 'orgId');
      validateId(paymentRequestId, 'paymentRequestId');
      if (!actor || typeof actor !== 'object') throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Authenticated actor is required to access a payment proof.');
      const allowed = await authorizeReceipt({ actor, orgId, paymentRequestId });
      if (allowed !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to access this payment proof.');
      const request = await repository.getReceiptReference({ orgId, paymentRequestId });
      if (!request) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Payment request was not found for this organization.');
      const expectedPrefix = `billing/payment-proofs/${orgId}/`;
      if (!request.proofObjectKey || !request.proofObjectKey.startsWith(expectedPrefix)) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Payment proof reference is missing or outside the organization storage namespace.', { retryable: true });
      }
      return Object.freeze({ url: await proofStorage.signedDownload({ key: request.proofObjectKey, expiresIn }), expiresIn });
    },
  });
}

module.exports = { createPaymentSubmissionService, fingerprint, stableJson };
