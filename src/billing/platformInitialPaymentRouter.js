'use strict';

const express = require('express');
const multer = require('multer');
const { validateId } = require('./kernel/scope');
const { buildBillingContext } = require('./httpContext');
const { createPlatformInitialPaymentSubmitForRequest } = require('./paymentHttpComposition');
const { paymentError, readCommand } = require('./paymentSubmissionRouter');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1, parts: 2 } }).single('proof');

function requirePaymentReviewEnabled(_req, res, next) {
  if (process.env.BILLING_PAYMENT_SUBMISSION_ENABLED !== 'true' || process.env.BILLING_PAYMENT_DECISION_ENABLED !== 'true') {
    return res.status(503).json({ code: 'BILLING_PAYMENT_SUBMISSION_DISABLED', error: 'Payment submission and review must be enabled before collecting initial subscription payments.' });
  }
  next();
}

router.post('/organizations/:orgId/initial-subscription-payment', requirePaymentReviewEnabled,
  (req, res, next) => upload(req, res, error => error ? paymentError(res, error) : next()), async (req, res) => {
    try {
      const orgId = validateId(req.params.orgId, 'orgId');
      if (!req.file) return res.status(400).json({ error: 'Payment proof is required.' });
      const commandReq = { ...req, orgId };
      const command = readCommand(commandReq);
      if (command.purpose !== 'subscription' || !command.quoteId) return res.status(400).json({ error: 'An initial subscription quote is required.' });
      const rawKey = req.get('Idempotency-Key');
      const trustedContext = buildBillingContext({ orgId, userId: req.userId, method: req.method, path: req.path,
        body: command, get: name => name.toLowerCase() === 'idempotency-key' ? rawKey : undefined });
      const record = await createPlatformInitialPaymentSubmitForRequest(req, orgId).submit({ command, trustedContext, proofFile: req.file });
      return res.status(201).json({ id: record.id, purpose: record.purpose, status: record.status,
        expectedAmount: record.expectedAmount, submittedAt: record.submittedAt });
    } catch (error) { return paymentError(res, error); }
  });

module.exports = { router, requirePaymentReviewEnabled };
