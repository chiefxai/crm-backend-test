'use strict';

const periodMath = require('./periodMath');
const lifecycle = require('./lifecycleService');
const mysqlPeriods = require('./repositories/mysqlPeriodRepository');
const activation = require('./periodActivationService');
const jobs = require('./periodJobs');
const accessJobs = require('./accessJobs');
const policy = require('./policy');
const initialPurchase = require('./initialPurchaseService');

module.exports = { ...periodMath, ...lifecycle, ...mysqlPeriods, ...activation, ...jobs, ...accessJobs, ...policy, ...initialPurchase };
