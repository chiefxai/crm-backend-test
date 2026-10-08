'use strict';

const crypto = require('node:crypto');
const { validateInvoiceClose, validateCreditNote } = require('../../../contracts/commands');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

function createInvoiceService({ unitOfWork, repository, clock, authorizeClose, authorizeCreditNote, resolvePeriodTerms } = {}) {
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Invoice service requires UnitOfWork.runFinancial().');
  if (typeof repository?.closePeriod !== 'function' || typeof repository?.addCreditNote !== 'function') throw new TypeError('Invoice service requires invoice repository close and credit-note methods.');
  if (typeof clock?.now !== 'function' || typeof authorizeClose !== 'function' || typeof authorizeCreditNote !== 'function' || typeof resolvePeriodTerms !== 'function') throw new TypeError('Invoice service requires clock, authorizers, and period terms resolver.');

  async function closePeriod({ command, trustedContext } = {}) {
    const value = validateInvoiceClose(command, trustedContext);
    if (await authorizeClose({ actor: value.context.actor, orgId: value.orgId, periodId: value.periodId }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to close the billing period invoice.');
    const now = clock.now();
    return unitOfWork.runFinancial({ orgId: value.orgId, operationId: value.context.operationId,
      requestFingerprint: fingerprint({ orgId: value.orgId, periodId: value.periodId, invoiceNumber: value.invoiceNumber, dueAt: value.dueAt }),
      expectedVersions: value.context.expectedVersions,
      callback: async (tx) => {
        const resolved = await resolvePeriodTerms({ tx, orgId: value.orgId, periodId: value.periodId, at: now });
        if (!resolved || typeof resolved !== 'object' || resolved.periodId !== value.periodId || !resolved.termsSnapshot) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Invoice period resolver returned an invalid purchased terms snapshot.');
        return repository.closePeriod(tx, { orgId: value.orgId, periodId: value.periodId, invoiceNumber: value.invoiceNumber, dueAt: value.dueAt, termsSnapshot: resolved.termsSnapshot });
      },
    });
  }

  async function issueCreditNote({ command, trustedContext } = {}) {
    const value = validateCreditNote(command, trustedContext);
    if (await authorizeCreditNote({ actor: value.context.actor, orgId: value.orgId, invoiceId: value.invoiceId, reason: value.reason }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to issue an invoice credit note.');
    const now = clock.now();
    return unitOfWork.runFinancial({ orgId: value.orgId, operationId: value.context.operationId,
      requestFingerprint: fingerprint({ orgId: value.orgId, invoiceId: value.invoiceId, invoiceLineId: value.invoiceLineId, amount: value.amount, reason: value.reason, expectedVersion: value.expectedVersion, actorId: value.context.actor.id }),
      expectedVersions: value.context.expectedVersions,
      callback: async (tx) => {
        const invoice = await repository.getForUpdate(tx, { orgId: value.orgId, invoiceId: value.invoiceId });
        if (!invoice) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Invoice was not found.');
        if (invoice.version !== value.expectedVersion) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Invoice version is stale.', { details: { expectedVersion: value.expectedVersion, actualVersion: invoice.version } });
        return repository.addCreditNote(tx, { orgId: value.orgId, invoiceId: value.invoiceId, invoiceLineId: value.invoiceLineId,
          operationId: value.context.operationId, amount: value.amount, reason: value.reason, actorId: value.context.actor.id, now });
      },
    });
  }

  return Object.freeze({ closePeriod, issueCreditNote });
}

module.exports = { createInvoiceService };
