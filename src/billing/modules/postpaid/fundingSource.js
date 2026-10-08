'use strict';

/** Transactional adapter that reserves and releases durable postpaid exposure. */
function createPostpaidFundingSource({ repository } = {}) {
  for (const method of ['reserveExposure', 'releaseExposure', 'settleReservedExposure', 'recordDebtJournal', 'reverseSettledExposure']) {
    if (typeof repository?.[method] !== 'function') throw new TypeError(`Postpaid funding source requires repository.${method}().`);
  }
  return Object.freeze({
    supports({ fallbackMode, workspacePolicy } = {}) {
      return fallbackMode === 'postpaid' && workspacePolicy?.enabled === true
        && ['limited', 'unlimited'].includes(workspacePolicy.mode);
    },
    reserve(tx, request) { return repository.reserveExposure(tx, request); },
    release(tx, request) { return repository.releaseExposure(tx, request); },
    settle(tx, request) { return repository.settleReservedExposure(tx, request); },
    journal(tx, request) { return repository.recordDebtJournal(tx, request); },
    reverse(tx, request) { return repository.reverseSettledExposure(tx, request); },
  });
}

module.exports = { createPostpaidFundingSource };
