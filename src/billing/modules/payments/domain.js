'use strict';

const crypto = require('node:crypto');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');

const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const MIME_SIGNATURES = Object.freeze([
  { type: 'application/pdf', matches: (b) => b.length >= 5 && b.subarray(0, 5).toString('ascii') === '%PDF-' },
  { type: 'image/png', matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { type: 'image/jpeg', matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/webp', matches: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
]);

function invalid(message, details) {
  throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, message, { details });
}

function validateProof(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) invalid('Payment proof must be provided as a buffered file.');
  if (file.buffer.length < 1 || file.buffer.length > MAX_PROOF_BYTES) {
    invalid('Payment proof must be between 1 byte and 10 MiB.', { maxBytes: MAX_PROOF_BYTES });
  }
  const signature = MIME_SIGNATURES.find((candidate) => candidate.matches(file.buffer));
  if (!signature) invalid('Payment proof must be a PDF, JPEG, PNG, or WEBP file.');
  if (file.mimetype && file.mimetype.toLowerCase() !== signature.type) {
    invalid('Payment proof content does not match its declared media type.', { detectedType: signature.type });
  }
  return Object.freeze({ buffer: file.buffer, contentType: signature.type, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex') });
}

function normalizeReference(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-US');
}

function validateQuoteForSubmission({ purpose, quote, amount, now }) {
  if (!quote) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'The selected quote was not found for this organization.');
  const quoteTypeMatches = purpose === 'subscription'
    ? ['purchase', 'renewal'].includes(quote.quoteType)
    : purpose === 'topup' && quote.quoteType === 'topup';
  if (!quoteTypeMatches) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Payment purpose does not match the selected quote.');
  if (!['draft', 'accepted', 'pending_payment'].includes(String(quote.status).toLowerCase())) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'The quote is no longer available for payment submission.');
  }
  if (quote.paidAt) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'This quote has already been paid.');
  if (quote.validUntil && Date.parse(quote.validUntil) <= Date.parse(now)) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'The selected quote has expired.');
  }
  if (quote.amount.asset !== amount.asset || quote.amount.scale !== amount.scale) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Submitted payment amount does not use the quote currency and scale.');
  }
  if (BigInt(amount.units) !== BigInt(quote.amount.units)) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH, 'Submitted expected amount does not match the immutable quote total.', {
      details: { quotedUnits: quote.amount.units, submittedUnits: amount.units, asset: quote.amount.asset, scale: quote.amount.scale },
    });
  }
  return quote;
}

module.exports = { MAX_PROOF_BYTES, validateProof, normalizeReference, validateQuoteForSubmission };
