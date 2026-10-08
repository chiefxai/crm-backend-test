# Billing email delivery

BILL-18 provides the durable delivery adapter and contracts. BILL-19 must compose
the event handlers and schedule `createEmailDeliveryWorker().runOnce()` plus the
existing subscription renewal scanner. Business-event handlers only enqueue in
their database transaction; the SMTP call happens later, outside that transaction.

Delivery rows use deterministic IDs and keys, a database lease with a fencing
token, exponential retries for transient failures, and terminal `submitted`,
`skipped`, or `dead_letter` states. `submitted` means the SMTP server accepted the
message; it does not claim inbox delivery. Missing SMTP is recorded as `skipped`
with `SMTP_UNCONFIGURED`, so it is observable and does not block billing work.

Private contact-verification payloads are AES-256-GCM encrypted before entering
the outbox and remain encrypted in `billing_notification_deliveries.payload_json`.
Set `BILLING_EMAIL_PAYLOAD_KEY`
to a secret of at least 32 characters and preserve it across deployments and key
rotation. Rotation requires a version-aware decrypt path before replacing the
current key. The verification token is not placed in the in-app notification feed.

`src/email/templates.js` is the versioned registry. Existing welcome exports
remain available as compatibility wrappers. Email links assume the frontend
billing settings page will consume the `verifyContact` and `orgId` query values;
that UI/API link handling belongs to the later integration task.

Renewal candidates are based on the active period's persisted `ends_at`, use its
terms snapshot for the amount, and are scanned while the period remains active.
The scanner suppresses candidates with a scheduled or explicitly cancelled next
period, and its durable outbox event key makes each period reminder idempotent.
