'use strict';

// Read-only compatibility endpoint for the existing CRM billing console.
// This is deliberately NOT /overview: that endpoint has a different,
// credit-ledger-based contract and must not be fabricated from INR balances.
const router = require('express').Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { safeErrorMessage } = require('../observability/safeError');

function topupAvailable() {
  return process.env.BILLING_TOPUP_QUOTE_ENABLED === 'true'
    && process.env.BILLING_PAYMENT_SUBMISSION_ENABLED === 'true'
    && process.env.BILLING_PAYMENT_DECISION_ENABLED === 'true';
}

router.get('/capabilities', requireAuth, requirePermission('billing.read'), (_req, res) => {
  res.json({ topupAvailable: topupAvailable() });
});

router.get('/legacy-overview', requireAuth, requirePermission('billing.organization.read'), async (req, res) => {
  try {
    const { getOrganizationBillingConsole } = require('../billing/billingConsole');
    const result = await getOrganizationBillingConsole(req.orgId);
    if (!result) return res.status(404).json({ error: 'Organization not found' });
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: safeErrorMessage(error) });
  }
});


// Included monthly usage credits are plan entitlements, not automatically
// spendable credit grants. Only approved/activated subscription periods issue
// ledger credits. Expose the difference explicitly for existing/new orgs.
router.get('/subscription-credit-status', requireAuth, requirePermission('billing.organization.read'), async (req, res) => {
  try {
    const { readPlanCreditStatus } = require('../billing/planCreditStatus');
    const status = await readPlanCreditStatus(req.orgId);
    if (!status) return res.status(404).json({ error: 'Organization not found' });
    return res.json(status);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: safeErrorMessage(error) });
  }
});

// New billing read model; never substitute legacy INR balances for credit units.
router.get('/overview', requireAuth, requirePermission('billing.organization.read'), async (req, res) => {
  try {
    const { readBillingOverview } = require('../billing/overviewReadModel');
    const overview = await readBillingOverview(req.orgId);
    if (!overview) return res.status(404).json({ error: 'Organization not found' });
    if (overview.uninitialized) return res.status(409).json({
      code: 'BILLING_ACCOUNT_NOT_INITIALIZED',
      error: 'Billing ledger setup is pending for this organization. Contact platform support.',
    });
    return res.json(overview);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: safeErrorMessage(error) });
  }
});


router.get('/payments', requireAuth, requirePermission('billing.organization.read'), async (req, res) => {
  try {
    const { listPaymentRequests } = require('../billing/paymentReadModel');
    const result = await listPaymentRequests(req.orgId, {
      cursor: req.query.cursor,
      limit: req.query.limit,
      type: req.query.type,
    });
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: safeErrorMessage(error) });
  }
});

// Organization credit allocation uses the existing ledger and stays write-gated.
router.use(require('../billing/manualAllocationRouter').router);

// Organization top-up quote creation is separately feature gated.
router.use(require('../billing/topupQuoteRouter').router);
router.use(require('../billing/workspaceAddonRouter').router);

// Financial submission routes remain disabled unless explicitly enabled.
router.use(require('../billing/paymentSubmissionRouter').router);

module.exports = router;
