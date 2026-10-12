'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { safeErrorMessage } = require('../observability/safeError');
const { requireBillingAdmin, requireFeature, readKey } = require('./subscriptionPurchaseRouter');

function renewalResponse(value) {
  return { ...value, payment: { submissionEnabled: process.env.BILLING_PAYMENT_SUBMISSION_ENABLED === 'true'
    && process.env.BILLING_PAYMENT_DECISION_ENABLED === 'true', purpose: 'subscription', submissionPath: '/api/billing/payments' } };
}
function sendError(res, error) {
  const status = error?.statusCode || (error?.code === 'NOT_FOUND' ? 404
    : ['CONFLICT', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'RENEWAL_NOT_OPEN', 'RENEWAL_PAYMENT_PENDING'].includes(error?.code) ? 409
      : error?.code === 'SUBSCRIPTION_QUOTE_POLICY_UNAVAILABLE' ? 503 : 500);
  return res.status(status).json({ code: error?.code || 'SUBSCRIPTION_RENEWAL_ERROR', error: safeErrorMessage(error) });
}

function createSubscriptionRenewalRouter({ compositionFactory } = {}) {
  const router = express.Router();
  function composition() {
    if (typeof compositionFactory === 'function') return compositionFactory();
    return require('./subscriptionPurchaseCompositionFactory').createConfiguredSubscriptionRenewalComposition();
  }
  router.get('/subscription-renewal', requireAuth, requirePermission('billing.read'), requireBillingAdmin, requireFeature, async (req, res) => {
    try {
      const result = await composition().readRenewal(req.orgId);
      if (!result) return res.status(404).json({ code: 'SUBSCRIPTION_NOT_FOUND', error: 'Organization subscription was not found.' });
      return res.json(renewalResponse(result));
    } catch (error) { return sendError(res, error); }
  });
  router.post('/subscription-renewal/quote', requireAuth, requirePermission('billing.read'), requireBillingAdmin, requireFeature, async (req, res) => {
    const requestKey = readKey(req, res);
    if (!requestKey) return undefined;
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['targetPlanId', 'targetPlanVersion'].includes(key))
      || (body.targetPlanId !== undefined && (typeof body.targetPlanId !== 'string' || !Number.isSafeInteger(body.targetPlanVersion)))) {
      return res.status(400).json({ code: 'INVALID_RENEWAL_PLAN', error: 'Choose a plan ID and published version supplied by the billing service.' });
    }
    try {
      const result = await composition().createRenewalQuote({ orgId: req.orgId, requestKey,
        targetPlanId: body.targetPlanId, targetPlanVersion: body.targetPlanVersion });
      if (!result) return res.status(404).json({ code: 'SUBSCRIPTION_NOT_FOUND', error: 'Organization subscription was not found.' });
      return res.status(201).json(renewalResponse(result));
    } catch (error) { return sendError(res, error); }
  });
  return router;
}

module.exports = { createSubscriptionRenewalRouter, renewalResponse, sendError };
