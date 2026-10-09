'use strict';

// Read-only compatibility endpoint for the existing CRM billing console.
// This is deliberately NOT /overview: that endpoint has a different,
// credit-ledger-based contract and must not be fabricated from INR balances.
const router = require('express').Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { safeErrorMessage } = require('../observability/safeError');

router.get('/legacy-overview', requireAuth, requirePermission('billing.read'), async (req, res) => {
  try {
    const { getOrganizationBillingConsole } = require('../billing/billingConsole');
    const result = await getOrganizationBillingConsole(req.orgId);
    if (!result) return res.status(404).json({ error: 'Organization not found' });
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: safeErrorMessage(error) });
  }
});

module.exports = router;
