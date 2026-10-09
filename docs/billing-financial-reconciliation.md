# Financial reconciliation — read-only staging audit

The isolated feature branch provides a bounded, **read-only** organization billing audit. No HTTP route, cron job, or automatic scheduler is registered, and the runner does **not** issue credits, reverse payments, settle invoices, or repair state.

## Checks

- `ACTIVE_SUBSCRIPTION_UNFUNDED` — an active subscription period lacks the approved subscription payment fulfillment linked to that period.
- `DUPLICATE_SUBSCRIPTION_GRANT` — more than one subscription credit grant references the same period.
- `APPROVED_TOPUP_UNFULFILLED` — an approved top-up lacks a `topup_credit_grant` fulfillment.
- `INVALID_CREDIT_POSITION` — negative credit balances, negative reserves, or reserves exceeding balance.
- `APPROVED_INVOICE_UNFULFILLED` — an approved invoice payment lacks an `invoice_payment` fulfillment.

The queries run within a single repeatable-read, read-only transaction, scoped by the explicitly selected organization. Each check has a maximum result limit of 100; reports set `complete: false` when any check has additional findings, so a truncated result is not mistaken for a clean audit. An account not initialized in the new billing ledger returns `initialized: false`.

These checks do **not** prove complete reconciliation of all journal activity or settlement records. No finding authorizes automatic repairs.

## Manual staging invocation

Only after test migrations have been applied and the database connection points to **staging**:

```sh
BILLING_RECONCILIATION_ENABLED=true \
BILLING_RECONCILIATION_ORG_ID=your_test_org \
BILLING_RECONCILIATION_LIMIT=25 \
node scripts/run-billing-reconciliation-once.js
```

Without the enable flag, the runner reports `skipped` and does not construct the reconciler. A finding or truncated report gives process exit status 2; a failed query gives status 1. Do not use the staging invocation against a production database without a separate operational review.

## Release blockers

1. Execute `node --test tests/billing/reconciliationReadModel.test.js` and the complete billing test suite.
2. Run MySQL integration tests to validate the query plans, schema migration names, timestamp precision, read-only snapshot and concurrency behavior.
3. Verify deliberately corrupted staging fixtures are detected and a valid fully funded billing cycle produces no false alarms.
4. Add journal-to-position, entitlement, allocation, provider payment proof, and invoice balance audits.
5. Establish a supervised operational workflow for manual review and resolution; **do not auto-repair ledger or grant balances**.
6. Keep all financial enforcement and background worker feature flags disabled until end-to-end tests pass and release approval is obtained.

Status: read-only audit implemented on a feature branch; not executed against a database and not production-ready.
