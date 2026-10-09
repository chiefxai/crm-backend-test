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


// New billing read model; never substitute legacy INR balances for credit units.
router.get('/overview', requireAuth, requirePermission('billing.read'), async (req, res) => {
  try {
    const { readBillingOverview } = require('../billing/overviewReadModel');
    const overview = await readBillingOverview(req.orgId);
    if (!overview) return res.status(404).json({ error: 'Organization not found' });
    if (overview.uninitialized) return res.status(409).json({
      code: 'BILLING_ACCOUNT_NOT_INITIALIZED',
      error: 'The organization has not been migrated to the new billing ledger.',
    });
    return res.json(overview);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: safeErrorMessage(error) });
  }
});

module.exports = router;
