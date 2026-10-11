'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { safeErrorMessage } = require('../observability/safeError');
const { createSubscriptionPurchaseComposition } = require('./subscriptionPurchaseComposition');

const FEATURE_FLAG = 'BILLING_SUBSCRIPTION_PURCHASE_ENABLED';
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BILLING_ADMIN_ROLES = new Set(['Owner', 'Organization Admin', 'Billing Admin']);

function enabled() { return process.env[FEATURE_FLAG] === 'true'; }
function paymentAvailable() {
  return process.env.BILLING_PAYMENT_SUBMISSION_ENABLED === 'true'
    && process.env.BILLING_PAYMENT_DECISION_ENABLED === 'true';
}
function requireBillingAdmin(req, res, next) {
  if (!BILLING_ADMIN_ROLES.has(req.authorization?.organizationRole)) {
    return res.status(403).json({ code: 'BILLING_ADMIN_REQUIRED', error: 'Organization billing administrator access is required.' });
  }
  next();
}
function requireFeature(_req, res, next) {
  if (!enabled()) return res.status(503).json({ code: 'SUBSCRIPTION_PURCHASE_DISABLED', error: 'Initial subscription purchase is not enabled.' });
  next();
}
function readKey(req, res) {
  const value = req.get('Idempotency-Key');
  if (typeof value !== 'string' || !IDEMPOTENCY_PATTERN.test(value)) {
    res.status(400).json({ code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'A valid Idempotency-Key header is required.' });
    return null;
  }
  return value;
}
function emptyBody(req, res) {
  if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) {
    res.status(400).json({ code: 'SERVER_RESOLVED_PLAN_REQUIRED', error: 'The selected plan and purchase terms are resolved from the organization record.' });
    return false;
  }
  return true;
}
function purchaseResponse(value) {
  const quote = value?.quote || value;
  const subscription = value?.subscription || {
    lifecycleStatus: quote.lifecycleStatus || 'onboarding',
    accessState: quote.billingAccessState || 'billing_recovery',
    planId: quote.plan?.id || null,
    planVersion: quote.plan?.version || null,
  };
  const parsedExpiry = Date.parse(quote.validUntil);
  const isExpired = quote.expired === undefined
    ? !Number.isFinite(parsedExpiry) || parsedExpiry <= Date.now() : Boolean(quote.expired);
  return {
    subscription,
    quote: {
      quoteId: quote.quoteId,
      purpose: 'purchase',
      status: quote.status || quote.quoteStatus || 'draft',
      version: quote.version || quote.quoteVersion || 1,
      plan: quote.plan || null,
      inventory: quote.inventory || null,
      lines: quote.lines || [],
      subtotal: quote.subtotal || null,
      discounts: quote.discounts || null,
      totalTax: quote.totalTax || null,
      paymentAmount: quote.paymentAmount || quote.total,
      includedCredits: quote.includedCredits || null,
      createdAt: quote.createdAt || null,
      validUntil: quote.validUntil,
      expired: isExpired,
      payable: !isExpired && (quote.payable !== false) && ['draft', 'accepted'].includes(String(quote.status || quote.quoteStatus || 'draft').toLowerCase()),
    },
    payment: {
      submissionEnabled: paymentAvailable(),
      purpose: 'subscription',
      submissionPath: '/api/billing/payments',
    },
  };
}
function sendError(res, error) {
  const status = error?.statusCode || (error?.code === 'NOT_FOUND' ? 404
    : error?.code === 'CONFLICT' || error?.code === 'VERSION_CONFLICT' || error?.code === 'IDEMPOTENCY_CONFLICT' ? 409
      : error?.code === 'SUBSCRIPTION_QUOTE_POLICY_UNAVAILABLE' ? 503 : 500);
  return res.status(status).json({ code: error?.code || 'SUBSCRIPTION_PURCHASE_ERROR', error: safeErrorMessage(error) });
}

function createSubscriptionPurchaseRouter({ compositionFactory, resolvePlanVersion, pool, idSource, clock, quoteTtlSeconds, subscriptionPolicy } = {}) {
  const router = express.Router();
  function composition() {
    if (typeof compositionFactory === 'function') return compositionFactory();
    if (typeof resolvePlanVersion !== 'function') throw Object.assign(new Error('Canonical workspace-plan catalog resolver is not configured.'), { statusCode: 503, code: 'SUBSCRIPTION_CATALOG_UNAVAILABLE' });
    return createSubscriptionPurchaseComposition({ resolvePlanVersion, pool, idSource, clock, quoteTtlSeconds, subscriptionPolicy });
  }

  router.get('/subscription-purchase', requireAuth, requirePermission('billing.read'), requireBillingAdmin, requireFeature, async (req, res) => {
    try {
      const result = await composition().readInitialQuote(req.orgId);
      if (!result) return res.status(404).json({ code: 'INITIAL_SUBSCRIPTION_NOT_FOUND', error: 'Initial subscription onboarding was not found for this organization.' });
      return res.json(purchaseResponse(result));
    } catch (error) { return sendError(res, error); }
  });

  // Idempotent provisioning/recovery path. The browser supplies an idempotency
  // key, while the domain service enforces the single initial quote per org.
  // No plan, price, amount, actor, or organization scope is accepted from body.
  router.post('/subscription-purchase/initial-quote', requireAuth, requirePermission('billing.read'), requireBillingAdmin, requireFeature, async (req, res) => {
    const key = readKey(req, res);
    if (!key) return undefined;
    if (!emptyBody(req, res)) return undefined;
    try {
      const service = composition();
      const existing = await service.readInitialQuote(req.orgId);
      if (existing?.quote && !existing.quote.expired) return res.status(200).json(purchaseResponse(existing));
      const created = await service.provisionInitialQuote({ orgId: req.orgId, requestKey: key });
      if (!created) return res.status(404).json({ code: 'ORGANIZATION_NOT_FOUND', error: 'Organization was not found.' });
      const readback = await service.readInitialQuote(req.orgId);
      return res.status(201).json(purchaseResponse(readback || created));
    } catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = { router: createSubscriptionPurchaseRouter(), createSubscriptionPurchaseRouter, purchaseResponse,
  FEATURE_FLAG, enabled, paymentAvailable, requireBillingAdmin, requireFeature, readKey };
