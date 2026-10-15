# Product notification publishers

The product notifications catalog is **not** itself an event publisher.
Actual notifications are created with `publishQuietly` and persist in
`app_notifications` with a unique dedupe key. The shared email delivery
queue enqueues messages **only for users who explicitly opted into email**,
and delivery requires SMTP configuration.

## Implemented event sources

- `campaign.failed`: auto-dial job receives a terminal campaign-level
  compliance rejection (HTTP 403). Ordinary unanswered leads and
  insufficient balance pauses are **not** described as campaign failures.
- `billing.subscription_expiring`: bounded scan of authoritative active
  subscription periods expiring within the configured lead-time window,
  excluding periods already superseded by another active/scheduled period.
- `billing.trial_expiring`: same scan, but only when the immutable terms
  snapshot identifies `source: free_trial`.
- `billing.credits_low`: bounded scan of **actual INR credit positions**
  after reservations, using only active grants and accounts. A wallet
  without a persisted position is not treated as a low balance.
- `system.announcement`: explicit authenticated Platform Admin action:
  `POST /api/platform/notifications/announcements` with
  `{ "audience":"organization", "orgId":"<existing org>", "title":"...",
     "message":"...", "dedupeKey":"release-20261015" }`.
  For Platform Admin recipients set `audience:"platform"` and omit
  `orgId`. Do not expose the endpoint outside platform-admin permissions.

## Scheduling the billing scan

The scanner deliberately does not create a new unconditional server
timer. Install the database migration for unified notifications first,
ensure your SMTP worker and scheduler are running, then invoke the
existing billing lifecycle runner from your scheduler, for example once
a day:

```sh
BILLING_PRODUCT_NOTIFICATIONS_ENABLED=true \
BILLING_LIFECYCLE_MODE=product-notifications \
BILLING_LIFECYCLE_BATCH_SIZE=100 \
BILLING_RENEWAL_LEAD_SECONDS=604800 \
node scripts/run-billing-lifecycle-once.js
```

The scan uses `leadTimeSeconds` rounded up to days, default seven days.
By default low-credit threshold is **₹100**; the scan accepts an injected
`lowCreditThresholdInr` option for testing and future configuration.
Low-credit alerts can repeat at most once per seven-day UTC epoch per
organization and threshold. Every period warning is deduplicated per
period, audience and lead-time window. For more than 100 eligible
organizations/periods, install a paginated scheduler rather than treating
one bounded invocation as an exhaustive scan.

**Do not enable the job based only on a successful build.** Verify the
canonical trial snapshot shape and INR ledger SQL against staging data,
SMTP credentials, sender identity, accepted deliveries, recipient scope,
and alert counts before production activation. The runner is opt-in.
