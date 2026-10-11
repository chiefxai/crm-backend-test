'use strict';

const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { safeErrorMessage } = require('../observability/safeError');
const { createConfiguredSubscriptionGraceService } = require('./subscriptionGraceService');
const { listGraceRequests, readOrganizationGraceEligibility } = require('./subscriptionGraceReadModel');
const { resolveSubscriptionPolicy } = require('./modules/subscriptions/policy');

const FEATURE_FLAG = 'BILLING_SUBSCRIPTION_GRACE_ENABLED';
const ADMIN_ROLES = new Set(['Owner', 'Organization Admin', 'Billing Admin']);
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function enabled() { return process.env[FEATURE_FLAG] === 'true'; }
function requireEnabled(_req, res, next) {
  if (!enabled()) return res.status(503).json({ code: 'SUBSCRIPTION_GRACE_DISABLED', error: 'Subscription grace requests are not enabled.' });
  return next();
}
function requireOrgBillingAdmin(req, res, next) {
  if (!ADMIN_ROLES.has(req.authorization?.organizationRole)) return res.status(403).json({ code: 'BILLING_ADMIN_REQUIRED', error: 'Organization billing administrator access is required.' });
  return next();
}
function operationId(req, res) {
  const value = req.get('Idempotency-Key');
  if (!value || !OPERATION_PATTERN.test(value)) {
    res.status(400).json({ code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'A valid Idempotency-Key header is required.' });
    return null;
  }
  return value;
}
function rejectServerFields(body, res) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ code: 'INVALID_REQUEST', error: 'A JSON object is required.' }); return true;
  }
  if (['orgId', 'actor', 'actorId', 'requestedBy', 'decidedBy', 'context'].some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
    res.status(400).json({ code: 'SERVER_ASSIGNED_FIELDS', error: 'Organization and actor context are assigned by the server.' }); return true;
  }
  return false;
}
function errorResponse(res, error) {
  const status = error?.statusCode || (error?.code === 'NOT_FOUND' ? 404 : error?.code === 'VERSION_CONFLICT' ? 409 : error instanceof TypeError ? 400 : 500);
  return res.status(status).json({ code: error?.code || 'SUBSCRIPTION_GRACE_ERROR', error: safeErrorMessage(error) });
}
function getService(factory) { return typeof factory === 'function' ? factory() : createConfiguredSubscriptionGraceService(); }

function createOrganizationSubscriptionGraceRouter({ serviceFactory, pool, policy } = {}) {
  const router = express.Router();
  router.get('/subscription-grace-requests', requireAuth, requirePermission('billing.organization.read'), requireOrgBillingAdmin, requireEnabled, async (req, res) => {
    try {
      const db = pool || require('../db/pool').getPool();
      const resolvedPolicy = resolveSubscriptionPolicy(policy || {});
      const [items, eligibility] = await Promise.all([
        listGraceRequests(db, { orgId: req.orgId, status: req.query.status || 'all', limit: req.query.limit }),
        readOrganizationGraceEligibility(db, { orgId: req.orgId, maxDaysPerPeriod: resolvedPolicy.grace.maxDaysPerPeriod,
          billingTimeZone: resolvedPolicy.billingTimeZone }),
      ]);
      return res.json({ items, eligibility });
    }
    catch (error) { return errorResponse(res, error); }
  });
  router.post('/subscription-grace-requests', requireAuth, requirePermission('billing.read'), requireOrgBillingAdmin, requireEnabled, async (req, res) => {
    const key = operationId(req, res); if (!key || rejectServerFields(req.body, res)) return undefined;
    try {
      const result = await getService(serviceFactory).createRequest({ orgId: req.orgId, actorId: req.userId,
        periodId: req.body.periodId, requestedUntil: req.body.requestedUntil, justification: req.body.justification,
        expectedVersion: req.body.expectedVersion, operationId: key });
      return res.status(201).json(result);
    } catch (error) { return errorResponse(res, error); }
  });
  return router;
}

function createPlatformSubscriptionGraceRouter({ serviceFactory, pool } = {}) {
  const router = express.Router();
  router.get('/billing/subscription-grace-requests', requireEnabled, async (req, res) => {
    try { return res.json({ items: await listGraceRequests(pool || require('../db/pool').getPool(), { status: req.query.status || 'requested', limit: req.query.limit }) }); }
    catch (error) { return errorResponse(res, error); }
  });
  router.post('/billing/organizations/:orgId/subscription-grace-requests/:graceRequestId/decision', requireEnabled, async (req, res) => {
    const key = operationId(req, res); if (!key || rejectServerFields(req.body, res)) return undefined;
    try {
      const result = await getService(serviceFactory).decide({ orgId: req.params.orgId, graceRequestId: req.params.graceRequestId,
        actorId: req.userId, decision: req.body.decision, reason: req.body.reason, expectedVersion: req.body.expectedVersion,
        grantedUntil: req.body.grantedUntil, operationId: key });
      return res.json(result);
    } catch (error) { return errorResponse(res, error); }
  });
  return router;
}

module.exports = { createOrganizationSubscriptionGraceRouter, createPlatformSubscriptionGraceRouter, FEATURE_FLAG, enabled,
  operationId, rejectServerFields, requireOrgBillingAdmin, requireEnabled, errorResponse };
