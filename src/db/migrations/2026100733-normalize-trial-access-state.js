'use strict';

// Free-trial provisioning previously wrote "active", while request-time
// access enforcement and expiry jobs use "operational" for usable access.
// Normalize existing active subscriptions so trials created by that release
// remain available and are scanned by the expiry scheduler.
module.exports = {
  id: '2026100733_normalize_trial_access_state',
  steps: [
    { sql: `UPDATE organization_subscriptions
               SET billing_access_state='operational',updated_at=UTC_TIMESTAMP(6)
             WHERE billing_access_state='active'
               AND lifecycle_status='active'
               AND current_period_id IS NOT NULL` },
  ],
};
