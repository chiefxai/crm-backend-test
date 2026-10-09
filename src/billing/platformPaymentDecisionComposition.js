'use strict';

const crypto = require('node:crypto');
const { isPlatformAdminIdentity } = require('../middleware/auth');
const { getPool } = require('../db/pool');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { createMysqlPaymentDecisionRepository } = require('./modules/payments/repositories/mysqlPaymentDecisionRepository');
const { createPaymentDecisionService } = require('./modules/payments/decisions');
const { createMysqlCreditRepository } = require('./modules/credits/repositories/mysqlCreditRepository');
const { createMysqlPeriodRepository } = require('./modules/subscriptions/repositories/mysqlPeriodRepository');
const { createSubscriptionLifecycleService } = require('./modules/subscriptions/lifecycleService');
const { createMysqlAllocationRepository } = require('./modules/allocations/repositories/mysqlAllocationRepository');
const { createMysqlPostpaidRepository } = require('./modules/postpaid/repositories/mysqlPostpaidRepository');
const { createMysqlInvoiceRepository } = require('./modules/postpaid/invoices/mysqlInvoiceRepository');
const { createMysqlOutboxStore } = require('./adapters/mysql/outboxStore');

function authorizedPlatformDecision(req, actor, orgId) {
  return isPlatformAdminIdentity(req.authClaims, req.userEmail) === true
    && actor?.type === 'user'
    && actor.id === req.userId
    && actor.organizationId === orgId;
}

/**
 * Compose existing transactional ports, not new financial mutations.
 * Only call after identity authentication and platform-admin allowlist checks.
 */
function createPlatformPaymentDecisionForRequest(req, {
  pool = getPool(),
  idSource = { newId: prefix => `${prefix}-${crypto.randomUUID()}` },
  clock = { now: () => new Date().toISOString() },
} = {}) {
  const unitOfWork = createMysqlUnitOfWork({ pool, operationStore, idSource, clock });
  const periodRepository = createMysqlPeriodRepository();
  const allocations = createMysqlAllocationRepository({ idSource, clock });
  const periodLifecycle = createSubscriptionLifecycleService({
    unitOfWork, periodRepository, allocationRepository: allocations, idSource, clock,
  });
  const postpaid = createMysqlPostpaidRepository({ idSource, clock });
  const invoices = createMysqlInvoiceRepository({ idSource, clock, postpaidRepository: postpaid });
  const outbox = createMysqlOutboxStore({ pool, clock, tokenSource: idSource });
  return createPaymentDecisionService({
    unitOfWork,
    repository: createMysqlPaymentDecisionRepository({ idSource, clock }),
    creditRepository: createMysqlCreditRepository({ idSource, clock }),
    periodLifecycle,
    invoiceRepository: invoices,
    outbox,
    idSource, clock,
    authorizeDecision: async ({ actor, orgId }) => authorizedPlatformDecision(req, actor, orgId),
  });
}

module.exports = { createPlatformPaymentDecisionForRequest, authorizedPlatformDecision };
