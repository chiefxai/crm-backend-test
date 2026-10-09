# Scoped billing notification outbox worker

This branch adds a **type-allowlisted** outbox worker and one-shot entrypoint.

## Why a scoped worker?

The generic billing worker treats an unregistered event type as unsupported and permanently settles its claim. Running it against the entire billing outbox while consumers are incomplete can strand financial events. The notification worker must **only claim events it can process**.

Both `listReadyOrganizations` and `claimBatch` now optionally accept `allowedEventTypes`, which adds SQL-level filtering *before* rows are leased. Existing callers without a filter preserve their prior behavior, so generic dispatch must remain disabled until all consumers are registered.

The scoped worker registers these existing handler implementations:

- `BillingContactVerificationRequested.v1`
- `SubscriptionRenewalDue.v1`
- `PaymentConfirmed.v1`

These are mapped to the notification repository, private delivery repository, MySQL consumer transaction, and idempotent inbox marker. The worker does **not** claim `CreditGrantAllocationRequested.v1`, `SubscriptionPeriodActivated.v1`, or other unregistered financial events.

## Controlled execution

Default: **disabled**. For validated staging infrastructure only:

```sh
BILLING_NOTIFICATION_OUTBOX_ENABLED=true BILLING_NOTIFICATION_OUTBOX_BATCH_SIZE=25 \
  node scripts/run-billing-notification-outbox-once.js
```

A `BILLING_EMAIL_PAYLOAD_KEY` of at least 32 characters is required. This only converts relevant outbox events into notification/email delivery rows; actual SMTP delivery uses the separate, independently gated `run-billing-email-delivery-once.js` command.

The one-shot outbox command is intentionally **not** mounted into server startup, a cron job, or production process management.

## Unresolved release gates

1. Run and pass the full Node suite, with MySQL integration coverage of lease fences, duplicate claims, inbox deduplication, ack failure recovery, tenant isolation, and SQL event-type filtering.
2. Audit all produced event types and implement the remaining consumers (particularly credit grant allocations) before enabling a general-purpose outbox worker.
3. Verify notification recipients, deduplication, private encrypted contact verification, and SMTP delivery in staging.
4. Add operational tracing and dead-letter reconciliation reports to detect missing handlers, transient failures, and terminal failures.
5. Verify migrations and billing state invariants, and obtain a separate explicit deployment approval.

Status: code committed, not enabled, not database-tested, not production-ready.
