# Billing background delivery integration — staged rollout only

## Current implementation

- Subscription activation and renewal-due event enqueueing have separate, disabled-by-default one-shot commands (see `docs/billing-lifecycle-staging-runbook.md`).
- This change adds an isolated **email-delivery** one-shot worker using the existing MySQL notification-delivery repository, lease/fencing logic, template renderer, encryption payload codec, and SMTP adapter.
- The generic billing **outbox dispatcher is NOT started**. It currently marks unregistered event types unsupported/permanently failed, so starting it with a partial registry would be unsafe. All required billing event consumers, including allocation and notification consumers, must be registered and verified first.

## Email delivery gate

Email delivery runs only when `BILLING_EMAIL_DELIVERY_ENABLED=true`. Default is disabled. It also requires SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM, and a BILLING_EMAIL_PAYLOAD_KEY of at least 32 characters. A missing setting aborts before the worker connects to the queue; it must never treat an unconfigured SMTP adapter as successful customer delivery.

For **staging only** after confirming migrations and provider credentials:

```sh
BILLING_EMAIL_DELIVERY_ENABLED=true BILLING_EMAIL_DELIVERY_BATCH_SIZE=25 \
  node scripts/run-billing-email-delivery-once.js
```

The batch is bounded to 100 and the invocation is a single tick, not an automatic scheduler. Non-submitted outcomes cause a nonzero process status for operator review.

## Remaining production blockers

1. Finish registration of **every** generic outbox event handler or implement separate routing by event type, so unsupported events are not prematurely dead-lettered.
2. Run Node unit tests and database integration tests for worker claim, lease expiration, fencing, inbox deduplication, outbox retry, and email settlement.
3. Verify email payload-key rotation/recovery, encrypted receipt links, notification recipients, and SMTP provider semantics.
4. Confirm notification delivery status is independently reconciled with provider results (submitted is not confirmed received).
5. Ensure migrations are applied to staging and verify cross-tenant isolation.
6. Add monitoring and supervised scheduler only after the above passes; do not turn on production financial or email flags without a separate release approval.

Status: worker composition and a one-shot script committed; not executed against the production or staging database.
