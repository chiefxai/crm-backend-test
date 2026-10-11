'use strict';

const crypto = require('node:crypto');

function createConfiguredSubscriptionPurchaseComposition({ pool = require('../db/pool').getPool(), clock = { now: () => new Date().toISOString() }, idSource = { newId: (kind) => `${kind}-${crypto.randomUUID()}` } } = {}) {
  const { createPlanCatalogService } = require('./modules/catalog/planCatalogService');
  const { createMysqlPlanCatalogRepository } = require('./modules/catalog/repositories/mysqlPlanCatalogRepository');
  const { createWorkspacePlanCatalogSyncService } = require('./workspacePlanCatalogSync');
  const billingSettings = require('../platform/billingSettings');
  const catalogService = createPlanCatalogService({ repository: createMysqlPlanCatalogRepository({ pool }), idSource, clock });
  const sync = createWorkspacePlanCatalogSyncService({ getWorkspacePlans: billingSettings.getWorkspacePlans,
    getBillingPolicy: billingSettings.getSubscriptionTermsPolicy, catalogService, clock });
  return require('./subscriptionPurchaseComposition').createSubscriptionPurchaseComposition({
    pool, resolvePlanVersion: sync.resolvePlanVersion, idSource, clock,
  });
}

function createConfiguredSubscriptionRenewalComposition({ pool = require('../db/pool').getPool(), clock = { now: () => new Date().toISOString() }, idSource = { newId: (kind) => `${kind}-${crypto.randomUUID()}` } } = {}) {
  const { createPlanCatalogService } = require('./modules/catalog/planCatalogService');
  const { createMysqlPlanCatalogRepository } = require('./modules/catalog/repositories/mysqlPlanCatalogRepository');
  const { resolveSubscriptionPolicy } = require('./modules/subscriptions/policy');
  const catalogService = createPlanCatalogService({ repository: createMysqlPlanCatalogRepository({ pool }), idSource, clock });
  const policy = resolveSubscriptionPolicy();
  return require('./subscriptionRenewalComposition').createSubscriptionRenewalComposition({
    pool, getPlanVersion: ({ planId, version }) => catalogService.getVersion({ planId, version }), idSource, clock,
    renewalNoticeDays: policy.renewalNoticeDays, billingTimeZone: policy.billingTimeZone,
  });
}

module.exports = { createConfiguredSubscriptionPurchaseComposition, createConfiguredSubscriptionRenewalComposition };
