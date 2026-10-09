'use strict';

const router = require('express').Router();
const { validateId } = require('./kernel/scope');
const { buildBillingContext } = require('./httpContext');
const { CONTRACT_VERSION } = require('./contracts/validation');
const { DOMAIN_ERROR_CODES, isBillingDomainError } = require('./contracts/errors');
const { createPlatformPaymentDecisionForRequest } = require('./platformPaymentDecisionComposition');

function requireDecisionEnabled(_req, res, next) {
  if (process.env.BILLING_PAYMENT_DECISION_ENABLED !== 'true') {
    return res.status(503).json({
      code: 'BILLING_PAYMENT_DECISION_DISABLED',
      error: 'Manual payment decisions are not enabled.',
    });
  }
  next();
}

function decisionCommand(req) {
  validateId(req.params.orgId, 'orgId');
  validateId(req.params.paymentRequestId, 'paymentRequestId');
  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new TypeError('Payment decision must be a JSON object.');
    error.statusCode = 400;
    throw error;
  }
  for (const field of ['orgId', 'paymentRequestId', 'actor', 'context', 'receiptKey']) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      const error = new TypeError('Payment organization, request and actor context are assigned by the server.');
      error.statusCode = 400;
      throw error;
    }
  }
  return { ...input, schemaVersion: CONTRACT_VERSION,
    orgId: req.params.orgId, paymentRequestId: req.params.paymentRequestId };
}

function decisionError(res, error) {
  if (isBillingDomainError(error)) {
    const conflict = [DOMAIN_ERROR_CODES.CONFLICT, DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      DOMAIN_ERROR_CODES.VERSION_CONFLICT, DOMAIN_ERROR_CODES.PAYMENT_NOT_PENDING,
      DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY].includes(error.code);
    const status = error.code === DOMAIN_ERROR_CODES.FORBIDDEN ? 403
      : error.code === DOMAIN_ERROR_CODES.NOT_FOUND ? 404
      : error.code === DOMAIN_ERROR_CODES.RETRYABLE_STORAGE ? 503
      : conflict ? 409 : 400;
    return res.status(status).json({ code: error.code, error: error.message });
  }
  if (error?.statusCode === 400 || error instanceof TypeError) {
    return res.status(400).json({ error: error.message });
  }
  return res.status(500).json({ error: 'Payment decision could not be completed.' });
}

// Mounted only inside /api/platform, where requireAuthIdentityOnly and
// requirePlatformAdmin already gate the entire router. Not an organization API.
router.post('/billing/organizations/:orgId/payments/:paymentRequestId/decision',
  requireDecisionEnabled, async (req, res) => {
    try {
      const command = decisionCommand(req);
      const trustedContext = buildBillingContext({
        orgId: req.params.orgId,
        userId: req.userId,
        method: req.method,
        path: req.path,
        body: command,
        get: header => req.get(header),
      });
      const service = createPlatformPaymentDecisionForRequest(req);
      const result = await service.decide({ command, trustedContext });
      return res.json(result);
    } catch (error) {
      return decisionError(res, error);
    }
  });


router.get('/billing/payment-reviews', requireDecisionEnabled, async (req, res) => {
  try {
    const { listPlatformPaymentReviews } = require('./platformPaymentReviewReadModel');
    return res.json(await listPlatformPaymentReviews({
      status: req.query.status,
      limit: req.query.limit,
      cursor: req.query.cursor,
      orgId: req.query.orgId,
    }));
  } catch (error) {
    return decisionError(res, error);
  }
});

// Receipt access is restricted to the same verified platform-operator boundary.
router.get('/billing/organizations/:orgId/payments/:paymentRequestId/proof',
  requireDecisionEnabled, async (req, res) => {
    try {
      const { createMysqlPaymentSubmissionRepository } = require('./modules/payments/repositories/mysqlPaymentSubmissionRepository');
      const { createConfiguredPrivatePaymentProofStorage } = require('./adapters/storage/privatePaymentProofStorage');
      const { getPool } = require('../db/pool');
      const orgId = validateId(req.params.orgId, 'orgId');
      const paymentRequestId = validateId(req.params.paymentRequestId, 'paymentRequestId');
      const reference = await createMysqlPaymentSubmissionRepository({ pool: getPool() })
        .getReceiptReference({ orgId, paymentRequestId });
      if (!reference) return res.status(404).json({ error: 'Payment not found.' });
      if (typeof reference.proofObjectKey !== 'string'
        || !reference.proofObjectKey.startsWith(`billing/payment-proofs/${orgId}/`)) {
        return res.status(404).json({ error: 'Payment receipt unavailable.' });
      }
      const url = await createConfiguredPrivatePaymentProofStorage()
        .signedDownload({ key: reference.proofObjectKey, expiresIn: 120 });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ url, expiresIn: 120 });
    } catch (error) {
      return decisionError(res, error);
    }
  });

module.exports = { router, decisionCommand, requireDecisionEnabled, decisionError };
