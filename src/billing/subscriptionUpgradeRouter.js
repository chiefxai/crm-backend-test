'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { safeErrorMessage } = require('../observability/safeError');
const { requireBillingAdmin, readKey } = require('./subscriptionPurchaseRouter');
const { buildBillingContext } = require('./httpContext');

const FEATURE_FLAG = 'BILLING_SUBSCRIPTION_UPGRADE_PREVIEW_ENABLED';
function paymentCapability(quote) {
  return { submissionEnabled: false, submissionPath: null, purpose: 'subscription', quoteId: quote?.quoteId || null,
    payable: false, reason: 'UPGRADE_ENTITLEMENT_INTEGRATION_NOT_IMPLEMENTED' };
}
function requireFeature(_req, res, next) {
  if (process.env[FEATURE_FLAG] !== 'true') return res.status(503).json({ code: 'SUBSCRIPTION_UPGRADE_PREVIEW_DISABLED', error: 'Subscription upgrade preview is not enabled.' });
  next();
}
function sendError(res, error) {
  const status = error?.statusCode || (error?.code === 'NOT_FOUND' ? 404
    : ['CONFLICT', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_CONFLICT',
      'UPGRADE_NOT_AVAILABLE', 'DOWNGRADE_REQUIRES_RENEWAL'].includes(error?.code) ? 409
      : error?.code === 'SUBSCRIPTION_QUOTE_POLICY_UNAVAILABLE' ? 503
        : error instanceof TypeError ? 400 : 500);
  return res.status(status).json({ code: error?.code || 'SUBSCRIPTION_UPGRADE_PREVIEW_ERROR', error: safeErrorMessage(error) });
}
function validBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.every((key) => ['targetPlanId', 'targetPlanVersion', 'effectiveAt'].includes(key))
    && typeof body.targetPlanId === 'string' && Number.isSafeInteger(body.targetPlanVersion)
    && (body.effectiveAt === undefined || body.effectiveAt === 'immediate');
}

function createSubscriptionUpgradeRouter({ compositionFactory } = {}) {
  const router = express.Router();
  function composition() {
    if (typeof compositionFactory === 'function') return compositionFactory();
    return require('./subscriptionUpgradeCompositionFactory').createConfiguredSubscriptionUpgradeComposition();
  }

  router.post('/subscription-upgrade/quote', requireAuth, requirePermission('billing.read'), requireBillingAdmin, requireFeature, async (req, res) => {
    const requestKey = readKey(req, res);
    if (!requestKey) return undefined;
    if (!validBody(req.body)) return res.status(400).json({ code: 'INVALID_UPGRADE_REQUEST', error: 'Provide only a target plan ID, version, and optional immediate effectiveAt.' });
    try {
      const result = await composition().createImmediateUpgradeQuote({ orgId: req.orgId,
        targetPlanId: req.body.targetPlanId, targetPlanVersion: req.body.targetPlanVersion,
        effectiveAt: req.body.effectiveAt || 'immediate', trustedContext: buildBillingContext(req) });
      if (!result) return res.status(404).json({ code: 'SUBSCRIPTION_NOT_FOUND', error: 'Organization subscription was not found.' });
      const quote = result.quote || result;
      return res.status(201).json({ subscription: result.subscription || null, quote, payment: paymentCapability(quote) });
    } catch (error) { return sendError(res, error); }
  });

  router.get('/subscription-upgrade/quotes/:quoteId', requireAuth, requirePermission('billing.read'), requireBillingAdmin, requireFeature, async (req, res) => {
    try {
      const result = await composition().readQuote(req.orgId, req.params.quoteId);
      if (!result) return res.status(404).json({ code: 'UPGRADE_QUOTE_NOT_FOUND', error: 'Upgrade quote was not found for this organization.' });
      return res.json({ quote: result, payment: paymentCapability(result) });
    } catch (error) { return sendError(res, error); }
  });
  return router;
}

module.exports = { createSubscriptionUpgradeRouter, requireFeature, sendError, validBody, paymentCapability, FEATURE_FLAG };
