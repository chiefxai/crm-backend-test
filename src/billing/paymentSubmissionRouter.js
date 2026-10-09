'use strict';

const router = require('express').Router();
const multer = require('multer');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { buildBillingContext } = require('./httpContext');
const { createPaymentSubmitForRequest, BILLING_SUBMIT_ROLES } = require('./paymentHttpComposition');
const { CONTRACT_VERSION } = require('./contracts/validation');
const { isBillingDomainError, DOMAIN_ERROR_CODES } = require('./contracts/errors');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1, parts: 2 },
}).single('proof');

function rejectUnlessEnabled(_req, res, next) {
  if (process.env.BILLING_PAYMENT_SUBMISSION_ENABLED !== 'true') {
    return res.status(503).json({ code: 'BILLING_PAYMENT_SUBMISSION_DISABLED', error: 'Payment submission is not enabled.' });
  }
  next();
}
function requireBillingSubmitRole(req, res, next) {
  if (!BILLING_SUBMIT_ROLES.has(req.authorization?.organizationRole)) {
    return res.status(403).json({ error: 'Organization billing administrator access is required.' });
  }
  next();
}
function readCommand(req) {
  if (typeof req.body?.command !== 'string' || req.body.command.length > 10000) {
    const error = new TypeError('A valid command JSON form field is required.');
    error.statusCode = 400;
    throw error;
  }
  let input;
  try { input = JSON.parse(req.body.command); } catch (_) {
    const error = new TypeError('Invalid payment command JSON.');
    error.statusCode = 400;
    throw error;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new TypeError('Payment command must be an object.');
    error.statusCode = 400;
    throw error;
  }
  if ('orgId' in input || 'actor' in input || 'context' in input || 'receiptKey' in input) {
    const error = new TypeError('Organization, actor and receipt storage are assigned by the server.');
    error.statusCode = 400;
    throw error;
  }
  return { ...input, schemaVersion: CONTRACT_VERSION, orgId: req.orgId };
}
function paymentError(res, error) {
  if (error instanceof multer.MulterError) {
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Invalid payment proof upload.' });
  }
  if (isBillingDomainError(error)) {
    const code = error.code;
    const status = code === DOMAIN_ERROR_CODES.FORBIDDEN ? 403
      : code === DOMAIN_ERROR_CODES.NOT_FOUND ? 404
      : code === DOMAIN_ERROR_CODES.RETRYABLE_STORAGE ? 503
      : [DOMAIN_ERROR_CODES.VERSION_CONFLICT, DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY, DOMAIN_ERROR_CODES.CONFLICT,
        DOMAIN_ERROR_CODES.DUPLICATE_PAYMENT_REFERENCE].includes(code) ? 409 : 400;
    return res.status(status).json({ code, error: error.message });
  }
  if (error?.statusCode === 400 || error instanceof TypeError) {
    return res.status(400).json({ error: error.message });
  }
  return res.status(500).json({ error: 'Payment submission could not be completed.' });
}

router.post('/payments', requireAuth, requirePermission('billing.read'),
  requireBillingSubmitRole, rejectUnlessEnabled,
  (req, res, next) => upload(req, res, err => err ? paymentError(res, err) : next()),
  async (req, res) => {
    try {
      const trustedContext = buildBillingContext(req);
      const command = readCommand(req);
      if (!req.file) return res.status(400).json({ error: 'Payment proof is required.' });
      const service = createPaymentSubmitForRequest(req);
      const record = await service.submit({ command, trustedContext, proofFile: req.file });
      return res.status(201).json({
        id: record.id,
        purpose: record.purpose,
        status: record.status,
        expectedAmount: record.expectedAmount,
        receivedAmount: null,
        submittedAt: record.submittedAt,
        reviewedAt: null,
        informationRequest: null,
      });
    } catch (error) {
      return paymentError(res, error);
    }
  });

module.exports = { router, readCommand, paymentError, requireBillingSubmitRole };
