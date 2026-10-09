'use strict';

const crypto = require('node:crypto');
const { getPool } = require('../db/pool');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { createMysqlPaymentSubmissionRepository } = require('./modules/payments/repositories/mysqlPaymentSubmissionRepository');
const { createPaymentSubmissionService } = require('./modules/payments/submissions');
const { createConfiguredPrivatePaymentProofStorage } = require('./adapters/storage/privatePaymentProofStorage');

const BILLING_SUBMIT_ROLES = new Set(['Owner', 'Organization Admin', 'Billing Admin']);

function canSubmitPayment(req, actor, orgId) {
  return Boolean(
    actor?.type === 'user'
    && actor.id === req.userId
    && actor.organizationId === req.orgId
    && orgId === req.orgId
    && BILLING_SUBMIT_ROLES.has(req.authorization?.organizationRole)
  );
}

function createPaymentSubmitForRequest(req, {
  pool = getPool(),
  proofStorage,
  idSource = { newId: (prefix) => `${prefix}-${crypto.randomUUID()}` },
  clock = { now: () => new Date().toISOString() },
} = {}) {
  // Storage is resolved only for a permitted payment request. Missing
  // credentials fail closed instead of writing proof files to public storage.
  const storage = proofStorage || createConfiguredPrivatePaymentProofStorage();
  return createPaymentSubmissionService({
    unitOfWork: createMysqlUnitOfWork({ pool, operationStore, idSource, clock }),
    repository: createMysqlPaymentSubmissionRepository({ pool }),
    proofStorage: storage,
    idSource,
    clock,
    authorizeSubmission: async ({ actor, orgId }) => canSubmitPayment(req, actor, orgId),
    // No receipt-download route is exposed in this milestone.
    authorizeReceipt: async () => false,
  });
}

module.exports = { createPaymentSubmitForRequest, canSubmitPayment, BILLING_SUBMIT_ROLES };
