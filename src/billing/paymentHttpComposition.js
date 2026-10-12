'use strict';

const crypto = require('node:crypto');
const { getPool } = require('../db/pool');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { createMysqlPaymentSubmissionRepository } = require('./modules/payments/repositories/mysqlPaymentSubmissionRepository');
const { createPaymentSubmissionService } = require('./modules/payments/submissions');
const { createConfiguredPrivatePaymentProofStorage } = require('./adapters/storage/privatePaymentProofStorage');
const { isPlatformAdminIdentity } = require('../middleware/auth');

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

function createPlatformInitialPaymentSubmitForRequest(req, orgId, {
  pool = getPool(), proofStorage,
  idSource = { newId: (prefix) => `${prefix}-${crypto.randomUUID()}` },
  clock = { now: () => new Date().toISOString() },
} = {}) {
  const storage = proofStorage || createConfiguredPrivatePaymentProofStorage();
  return createPaymentSubmissionService({
    unitOfWork: createMysqlUnitOfWork({ pool, operationStore, idSource, clock }),
    repository: createMysqlPaymentSubmissionRepository({ pool }), proofStorage: storage, idSource, clock,
    authorizeSubmission: async ({ actor, orgId: targetOrgId, purpose, quoteId }) => {
      if (isPlatformAdminIdentity(req.authClaims, req.userEmail) !== true || targetOrgId !== orgId || purpose !== 'subscription' || actor?.type !== 'user'
        || actor.id !== req.userId || actor.organizationId !== orgId) return false;
      const rows = await pool.query(`SELECT l.id FROM billing_subscription_period_links l
        JOIN organization_subscriptions s ON s.org_id=l.org_id
        WHERE l.org_id=? AND l.quote_id=? AND l.purpose='initial_purchase'
          AND l.period_state='awaiting_payment' AND s.lifecycle_status='onboarding' LIMIT 1`, [orgId, quoteId]);
      const result = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
      return Array.isArray(result) && result.length > 0;
    },
    authorizeReceipt: async () => false,
  });
}

module.exports = { createPaymentSubmitForRequest, createPlatformInitialPaymentSubmitForRequest, canSubmitPayment, BILLING_SUBMIT_ROLES };
