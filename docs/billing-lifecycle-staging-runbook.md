# Subscription lifecycle invocation — staging-only runbook

The feature branch contains **bounded, explicitly invoked** lifecycle composition:
- `src/billing/lifecycleJobComposition.js` uses the existing period scanner, activation service, financial UnitOfWork, credit repository, and outbox.
- `scripts/run-billing-lifecycle-once.js` invokes **one** bounded activation or renewal-reminder scan.
- Neither service is registered on server startup nor attached to an automatic scheduler.

## Modes and independent rollout flags

| Mode | Required env flag | Effect |
| --- | --- | --- |
| `activate` | `BILLING_SUBSCRIPTION_ACTIVATION_ENABLED=true` | Activates *approved, funded, due* scheduled subscription periods and grants included credits transactionally. |
| `renewal-reminders` | `BILLING_RENEWAL_REMINDERS_ENABLED=true` | Enqueues renewal-due outbox events; delivery still requires a composed and running outbox/notification worker. |

Both flags are **disabled by default**. Do not enable either in production before approval.

For an intentionally configured **staging** environment only:

```sh
BILLING_LIFECYCLE_MODE=activate BILLING_LIFECYCLE_BATCH_SIZE=25 \
  BILLING_SUBSCRIPTION_ACTIVATION_ENABLED=true node scripts/run-billing-lifecycle-once.js

BILLING_LIFECYCLE_MODE=renewal-reminders BILLING_RENEWAL_LEAD_SECONDS=604800 \
  BILLING_RENEWAL_REMINDERS_ENABLED=true node scripts/run-billing-lifecycle-once.js
```

The batch size defaults to 25, hard capped at 100. The process returns a nonzero status for blocked activations or execution failures. A skipped flag returns a `skipped` result and creates no financial service instance.

**Important**: A successful reminder event enqueue does not mean email was delivered. Outbox worker wiring, recipient verification, retries, and delivery reconciliation are separate tasks.

## Release blockers

1. Apply and verify all billing migrations to a staging database and migrate test tenants.
2. Run `node --test tests/billing/lifecycleJobComposition.test.js` and all lifecycle, funding, allocation, invoice, outbox, and MySQL integration tests.
3. Verify a scheduled subscription remains unfunded and inactive until an *approved* payment fulfillment exists.
4. Verify simultaneous workers, duplicate tick retries, interrupted transactions, expired periods, and overlapping periods never double-activate or double-grant credits.
5. Confirm purchased included-credit amounts, entitlements, period state, and account/grant ledger invariants after every activation.
6. Verify renewal-due events are idempotent and no duplicate customer reminders are delivered.
7. Compose the outbox worker and delivery handlers, then add health checks and an operations runbook.
8. Obtain a separate production release authorization to deploy, schedule, or enable financial processing.

Status: lifecycle composition and a staging-only one-shot entrypoint implemented; **no production scheduler configured**, no test suite or live DB checks executed.
