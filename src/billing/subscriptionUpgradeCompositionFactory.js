'use strict';

const crypto = require('node:crypto');

function createConfiguredSubscriptionUpgradeComposition({ pool = require('../db/pool').getPool(),
  clock = { now: () => new Date().toISOString() }, idSource = { newId: (kind) => `${kind}-${crypto.randomUUID()}` } } = {}) {
  const { createPlanCatalogService } = require('./modules/catalog/planCatalogService');
  const { createMysqlPlanCatalogRepository } = require('./modules/catalog/repositories/mysqlPlanCatalogRepository');
  const catalogService = createPlanCatalogService({ repository: createMysqlPlanCatalogRepository({ pool }), idSource, clock });
  return require('./subscriptionUpgradeComposition').createSubscriptionUpgradeComposition({
    pool, getPlanVersion: ({ planId, version }) => catalogService.getVersion({ planId, version }), idSource, clock,
  });
}

module.exports = { createConfiguredSubscriptionUpgradeComposition };
