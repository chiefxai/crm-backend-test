# Billing contacts and notifications (BILL-17)

`src/billing/modules/notifications/` owns verified contacts, versioned alert
policies, hysteresis state, persistent notifications, recipients, and feed read
state. Organization notifications target organization owners/admins and billing
admins. Workspace notifications target the assigned workspace admins and org
admins. Verified billing contacts are snapshotted as recipients; pending or
disabled contacts are excluded. Per-user read state is stored on the recipient,
so one user's read action does not affect another user's feed.

Thresholds use integer credit units and basis points. Policies support either
or both amount and percentage triggers; when both are set, either can trigger.
`at_or_above` supports usage and exposure alerts. `at_or_below` supports low
available-credit alerts. Percentage comparison is skipped when the scope has no
positive finite limit, while an amount threshold remains effective. Use
`availableUnits(balance, held)` when evaluating a credit pool so reservations
reduce available balance. Recovery thresholds can be lower (or higher for
low-balance alerts) than trigger thresholds; cooldowns and persistent crossing
sequences deduplicate repeated observations.

Recommended stable event keys include `credits.available`, `credits.expiry`,
`fallback.changed`, `postpaid.exposure`, `payment.status`, and
`allocation.completed`. Callers submit observations with a scope, event key,
threshold key, measured amount and optional limit. The domain service evaluates
each matching policy and writes state and notification together in one
organization UnitOfWork.

Contact verification tokens are hashed in `billing_contacts` and expire after
the configured TTL. A verification request is placed in the transactional
outbox; no email is sent by BILL-17. The expiry column and index are added by
`2026100719_billing_contact_verification_expiry`.

No routes, permissions, event producers, scheduler, or delivery consumer are
registered here. BILL-18 owns email delivery; BILL-19 composes these modules,
registers endpoints and producers, and wires job scheduling. No migration was
applied and no real email was sent.
