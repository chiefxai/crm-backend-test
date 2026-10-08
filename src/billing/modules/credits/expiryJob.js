'use strict';

const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');

function createCreditExpiryJob({ candidateRepository, expiryService, clock } = {}) {
  if (typeof candidateRepository?.listDueGrants !== 'function') throw new TypeError('Credit expiry job requires listDueGrants().');
  if (typeof expiryService?.expireGrantPosition !== 'function') throw new TypeError('Credit expiry job requires expireGrantPosition().');
  if (typeof clock?.now !== 'function') throw new TypeError('Credit expiry job requires clock.now().');

  async function expireDueGrants({ now = clock.now(), limit = 100, after } = {}) {
    const candidates = await candidateRepository.listDueGrants({ now, limit, after });
    const results = [];
    for (const candidate of candidates) {
      try {
        results.push(await expiryService.expireGrantPosition({ orgId: candidate.orgId, grantId: candidate.grantId, accountId: candidate.accountId, now }));
      } catch (error) {
        if (error?.retryable || error?.code === DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY || error?.code === DOMAIN_ERROR_CODES.RETRYABLE_STORAGE) throw error;
        results.push({ grantId: candidate.grantId, accountId: candidate.accountId, status: 'blocked', errorCode: error?.code || DOMAIN_ERROR_CODES.GRANT_NOT_AVAILABLE });
      }
    }
    const last = candidates[candidates.length - 1];
    return Object.freeze({ scanned: candidates.length, results: Object.freeze(results), nextAfter: candidates.length === limit ? { expiresAt: last.expiresAt, orgId: last.orgId, grantId: last.grantId, accountId: last.accountId } : null });
  }

  return Object.freeze({ expireDueGrants });
}

module.exports = { createCreditExpiryJob };
