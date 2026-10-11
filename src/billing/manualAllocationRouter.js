'use strict';

const crypto = require('node:crypto');
const router = require('express').Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getPool } = require('../db/pool');
const { buildBillingContext } = require('./httpContext');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { createMysqlCreditRepository } = require('./modules/credits/repositories/mysqlCreditRepository');
const { createMysqlAllocationRepository } = require('./modules/allocations/repositories/mysqlAllocationRepository');
const { createAllocationService } = require('./modules/allocations/service');
const { organizationScope, workspaceScope, validateId } = require('./kernel/scope');
const { isBillingDomainError, DOMAIN_ERROR_CODES } = require('./contracts/errors');
const { CONTRACT_VERSION } = require('./contracts/validation');
const { readManualAllocationOverview, previewManualAllocation } = require('./manualAllocationReadModel');
const { getLogger } = require('../observability/logger');

const logger = getLogger('billing.manualAllocation');
const FINANCIAL_ROLES = new Set(['Owner', 'Organization Admin']);

function transfersEnabled(env = process.env) {
  // Financial writes require explicit operator opt-in after reconciliation.
  return env.BILLING_MANUAL_ALLOCATION_ENABLED === 'true';
}
function requireOrganizationCreditAdmin(req, res, next) {
  if (!FINANCIAL_ROLES.has(req.authorization?.organizationRole) || !req.authorization?.permissions?.includes('billing.credit.allocate')) {
    return res.status(403).json({ error: 'Only an organization administrator can allocate credits.' });
  }
  next();
}
function requireTransfersEnabled(req, res, next) {
  if (!transfersEnabled()) {
    return res.status(503).json({
      code: 'BILLING_MANUAL_ALLOCATION_DISABLED',
      error: 'Credit transfers are not enabled pending financial validation.',
    });
  }
  next();
}
function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key)))
    throw new TypeError('Unexpected allocation request fields.');
  return value;
}
function parsePreviewInput(value) {
  const v = exactObject(value, ['grantId','workspaceId','amountUnits','expectedPositionVersion']);
  return {
    grantId: validateId(v.grantId, 'grantId'),
    workspaceId: validateId(v.workspaceId, 'workspaceId'),
    amountUnits: v.amountUnits,
    expectedPositionVersion: v.expectedPositionVersion,
  };
}
function parseTransferInput(value) {
  const v = exactObject(value, ['grantId','workspaceId','amount','expectedPositionVersion']);
  const amount = exactObject(v.amount, ['asset','units','scale']);
  validateId(v.grantId, 'grantId');
  validateId(v.workspaceId, 'workspaceId');
  if (typeof amount.units !== 'string' || !/^[1-9][0-9]*$/.test(amount.units))
    throw new TypeError('Allocation amount must be a positive integer string.');
  return { grantId: v.grantId, workspaceId: v.workspaceId, amount,
    expectedPositionVersion: v.expectedPositionVersion };
}
function respondError(res, error) {
  if (isBillingDomainError(error)) {
    const conflict = [DOMAIN_ERROR_CODES.VERSION_CONFLICT, DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      DOMAIN_ERROR_CODES.CONFLICT, DOMAIN_ERROR_CODES.INSUFFICIENT_CREDITS,
      DOMAIN_ERROR_CODES.GRANT_EXPIRED, DOMAIN_ERROR_CODES.GRANT_NOT_AVAILABLE].includes(error.code);
    const status = error.code === DOMAIN_ERROR_CODES.FORBIDDEN ? 403
      : error.code === DOMAIN_ERROR_CODES.NOT_FOUND ? 404 : conflict ? 409
      : error.code === DOMAIN_ERROR_CODES.RETRYABLE_STORAGE ? 503 : 400;
    return res.status(status).json({ code: error.code, error: error.message });
  }
  if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
  if (error instanceof TypeError) return res.status(400).json({ error: error.message });
  logger.error('Unexpected manual allocation failure', { error });
  return res.status(500).json({ error: 'Credit allocation could not be completed.' });
}

function createManualTransferService(req, { pool = getPool() } = {}) {
  const idSource = { newId: prefix => `${prefix}-${crypto.randomUUID()}` };
  const clock = { now: () => new Date().toISOString() };
  const isAdmin = FINANCIAL_ROLES.has(req.authorization?.organizationRole)
    && req.authorization?.permissions?.includes('billing.credit.allocate');
  return createAllocationService({
    unitOfWork: createMysqlUnitOfWork({ pool, operationStore, idSource, clock }),
    creditRepository: createMysqlCreditRepository({ idSource, clock }),
    allocationRepository: createMysqlAllocationRepository({ idSource, clock }),
    idSource, clock,
    authorizeAllocation: async ({ actor, orgId, action, fromScope, toScope }) =>
      isAdmin && actor?.type === 'user' && actor.id === req.userId
      && actor.organizationId === req.orgId && orgId === req.orgId
      && action === 'credits.transfer' && fromScope?.ownerType === 'organization'
      && fromScope.ownerId === req.orgId && toScope?.ownerType === 'workspace',
  });
}

router.get('/manual-allocations', requireAuth, requirePermission('billing.organization.read'),
  requireOrganizationCreditAdmin, async (req, res) => {
    try {
      const snapshot = await readManualAllocationOverview(req.orgId);
      return res.json({ ...snapshot, transfersEnabled: transfersEnabled() });
    } catch (error) { return respondError(res, error); }
  });

router.post('/manual-allocations/preview', requireAuth, requirePermission('billing.credit.allocate'),
  requireOrganizationCreditAdmin, async (req, res) => {
    try {
      const input = parsePreviewInput(req.body);
      const snapshot = await readManualAllocationOverview(req.orgId);
      const preview = previewManualAllocation(snapshot, input);
      return res.json({ ...preview, transfersEnabled: transfersEnabled() });
    } catch (error) { return respondError(res, error); }
  });

router.post('/manual-allocations/transfer', requireAuth, requirePermission('billing.credit.allocate'),
  requireOrganizationCreditAdmin, requireTransfersEnabled, async (req, res) => {
    try {
      const input = parseTransferInput(req.body);
      // The client cannot select the organization, actor, or source account.
      // All movement is organization pool -> same-org workspace only.
      const command = {
        schemaVersion: CONTRACT_VERSION, orgId: req.orgId, grantId: input.grantId,
        fromScope: organizationScope(req.orgId),
        toScope: workspaceScope(req.orgId, input.workspaceId),
        amount: input.amount, expectedPositionVersion: input.expectedPositionVersion,
      };
      const trustedContext = buildBillingContext(req);
      const result = await createManualTransferService(req).transfer({ command, trustedContext });
      return res.status(200).json(result);
    } catch (error) { return respondError(res, error); }
  });

module.exports = {
  router, FINANCIAL_ROLES, transfersEnabled, requireOrganizationCreditAdmin,
  requireTransfersEnabled, parsePreviewInput, parseTransferInput, respondError,
  createManualTransferService,
};
