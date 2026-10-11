'use strict';

const express = require('express');
const { previewSubscriptionReconciliation } = require('./subscriptionReconciliationPreview');

function createSubscriptionReconciliationRouter({ preview = previewSubscriptionReconciliation } = {}) {
  const router = express.Router();
  router.get('/billing/subscription-reconciliation/preview', async (req, res) => {
    try {
      res.json(await preview({ limit: req.query.limit, offset: req.query.offset }));
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.statusCode && err.statusCode < 500
        ? err.message : 'Subscription reconciliation preview is unavailable.' });
    }
  });
  return router;
}

module.exports = { createSubscriptionReconciliationRouter };
