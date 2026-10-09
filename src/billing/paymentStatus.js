'use strict';

// Persisted payment states include historical aliases that do not belong to
// the organization billing API contract. Never silently pass an unknown
// persisted state to clients as though it were valid.
const API_STATUSES = Object.freeze({
  pending: 'pending_verification',
  pending_verification: 'pending_verification',
  needs_clarification: 'needs_information',
  clarification_requested: 'needs_information',
  needs_information: 'needs_information',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
});

function toPaymentApiStatus(status) {
  if (typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(API_STATUSES, status)) {
    throw new TypeError('Unknown persisted billing payment status.');
  }
  return API_STATUSES[status];
}

module.exports = { toPaymentApiStatus, API_STATUSES };
