'use strict';

const terms = require('./terms');
const planCatalog = require('./planCatalogService');
const quotes = require('./quote');
const entitlements = require('./entitlementResolver');
const mysql = require('./repositories/mysqlPlanCatalogRepository');
const organizationTerms = require('./organizationTermsService');
const mysqlOrganizationTerms = require('./repositories/mysqlOrganizationTermsRepository');
const workspacePlanMapper = require('./workspacePlanMapper');
const subscriptionQuoteComposition = require('./subscriptionQuoteComposition');
const mysqlSubscriptionQuote = require('./repositories/mysqlSubscriptionQuoteRepository');

module.exports = { ...terms, ...planCatalog, ...quotes, ...entitlements, ...mysql, ...organizationTerms, ...mysqlOrganizationTerms,
  ...workspacePlanMapper, ...subscriptionQuoteComposition, ...mysqlSubscriptionQuote };
