# Subscription lifecycle operations and release runbook

**Status: staging/review guidance only. This feature is not production-ready.** This document describes the code currently present and the release gates that remain. It does not authorize applying a migration, enabling a flag, starting a recurring worker, processing a real payment, or changing production access.

## Current implementation map

The migration `2026100727_subscription_lifecycle` adds subscription, period-link, and grace-request/decision tables. It is registered in the ordered migration list. `node scripts/migrate.js` waits for the database client readiness path, which runs the registered versioned migrations under the existing advisory lock. MySQL DDL is not transactionally reversible; treat rollback as forward-fix/disable, not dropping these tables.

The scheduler registry currently contains period activation (every five minutes by default), renewal reminders (hourly), access enforcement (every five minutes), and notification-outbox processing (every minute). Those definitions require the scheduler process to be deployed and running. Lifecycle handlers individually return `skipped` until their exact environment flag is `true`; registering a schedule alone does not activate it. The notification outbox has a separate flag. The email delivery worker is implemented separately and is not in `src/scheduler/definitions.js`.

| Capability | Current flag(s) | What enabling it does |
| --- | --- | --- |
| Initial subscription purchase and renewal quote APIs | `BILLING_SUBSCRIPTION_PURCHASE_ENABLED=true` | Enables purchase/renewal APIs and initial quote provisioning on organization creation. Creation preflight also requires `BILLING_SUBSCRIPTION_ACCESS_ENFORCEMENT_ENABLED=true`, configured terms and valid quote TTL. |
| Quote lifetime | `BILLING_SUBSCRIPTION_QUOTE_TTL_SECONDS` | Required when creating a quote; valid range is 60–604800 seconds. |
| Payment proof submission | `BILLING_PAYMENT_SUBMISSION_ENABLED=true` | Enables organization payment proof submission through the shared payments endpoint. |
| Payment review/decision | `BILLING_PAYMENT_DECISION_ENABLED=true` | Enables platform payment review/decision endpoints. A decision is a financial operation. |
| Period activation and included-credit grant | `BILLING_SUBSCRIPTION_ACTIVATION_ENABLED=true` | Allows the due-period scheduler/one-shot job to activate approved, funded periods and issue included credits. |
| Renewal reminder event creation | `BILLING_RENEWAL_REMINDERS_ENABLED=true` | Allows the hourly scan to enqueue due-renewal events; default lead is seven days (`BILLING_RENEWAL_LEAD_SECONDS`). |
| Expiry access enforcement | `BILLING_SUBSCRIPTION_ACCESS_ENFORCEMENT_ENABLED=true` | Enables request-time billing access checks and scheduled expiry enforcement. Missing subscription records fail closed when the request gate applies. |
| Grace request/decision APIs | `BILLING_SUBSCRIPTION_GRACE_ENABLED=true` | Enables organization grace requests and platform approve/deny operations. |
| Upgrade quote preview | `BILLING_SUBSCRIPTION_UPGRADE_PREVIEW_ENABLED=true` | Enables an immutable, read-only immediate-upgrade quote preview. It remains non-payable. No upgrade fulfillment flag is implemented; payment submission rejects adjustment quotes even if an unknown fulfillment environment variable is set. |
| Notification outbox event processing | `BILLING_NOTIFICATION_OUTBOX_ENABLED=true` | Processes allowlisted contact verification, renewal-due and payment-confirmed events into notification/delivery records. Requires `BILLING_EMAIL_PAYLOAD_KEY` of at least 32 characters. |
| Billing email delivery | `BILLING_EMAIL_DELIVERY_ENABLED=true` | Enables the separate delivery worker. Requires SMTP host/user/password/from and the payload key. No recurring schedule is registered here yet. |
| Existing billing reconciliation audit | `BILLING_RECONCILIATION_ENABLED=true` | Enables an explicitly named organization read-model audit only; it does not migrate legacy organizations or repair balances. |

Payment submission/decision flags are shared with existing billing flows, so enabling them may expose more than subscription payments. Confirm their full blast radius before use.

## Readiness blockers

Do not enable production subscription purchase or access enforcement until all of the following are complete:

1. SUB-12 has a bounded, reviewed, read-only inventory and an approved classification/reconciliation path for existing organizations. No such lifecycle migration/reconciliation tool is implemented. The current reconciliation runner only audits one specified organization and does not establish enforcement eligibility.
2. SUB-13 has completed staging MySQL integration and concurrency/recovery scenarios: duplicate approvals/ticks, overlapping or expired periods, funding/activation failures, approval-versus-suspension races, grace boundary cases, tenant isolation, and time-zone/month-end behavior. Focused tests are not a replacement for this evidence.
3. Payment and grace reviewers, permission boundaries, exact-amount validation, private receipt storage, payment instructions, support escalation, and finance reconciliation ownership are confirmed for the deployment.
4. Notification delivery has an actual supervised worker deployment, retries/dead-letter monitoring, verified billing recipients, and tested templates. Current scheduler registration runs the notification-outbox handler only; a separate email-delivery worker is not scheduled. Grace/access restriction/impending suspension notifications are not implemented. A successful outbox tick does not prove email delivery.
5. Operations metrics, alerts, dashboards, and a tested recovery procedure exist. They are not supplied by this feature branch.
6. SUB-06 remains incomplete: the preview computes a prorated quote, but no payment or approval path is enabled. Workspace authorization and legacy organization entitlements do not consume `organization_billing_terms` or an effective-plan history. Target inventory fit, scheduled downgrade, user UI, and staging evidence also remain open. Do not enable upgrade preview for customers.
7. Non-`requireAuth` paths (including internal-token APIs, workers, telephony/WebSocket tickets and calls already in progress) still need a documented and tested billing access policy. The request gate alone does not prove complete access enforcement.

The existing focused backend/frontend tests passed during implementation, but the full backend suite has unrelated failures and sandbox listener restrictions. The required full integration evidence remains outstanding. See `docs/subscription-lifecycle-tasks.md` for task-level scope and current status.

## Preflight for a future staging release

Use a disposable or explicitly approved staging tenant and database. Keep all feature flags off initially.

1. Review the exact release commit and database backup/restore procedure. Confirm MySQL version, migration lock behavior, DB credentials, private receipt storage, and isolation from production.
2. Apply the migration only under the deployment's approved change process: `node scripts/migrate.js`. Record the migration ID/checksum and verify `schema_migrations` plus all four lifecycle tables. Do not treat startup migration as a rollback strategy.
3. Configure versioned platform subscription terms and canonical published plan versions, including currency, fee, explicit tax and industry terms, billing timezone, renewal notice, grace limits, service-after-expiry behavior, and quote TTL. Confirm the plan's monthly usage credits remain distinct from its subscription fee.
4. Reconcile/classify every staging tenant before enabling the request gate. Check that a missing subscription row cannot accidentally strand test access; the gate deliberately fails closed for missing lifecycle state.
5. Validate the platform payment-review and grace-decision operators, role assignments, receipts, amount checks, idempotency behavior, and audit records.
6. Configure payment instructions and a verified billing contact. For email tests, set a strong `BILLING_EMAIL_PAYLOAD_KEY` (at least 32 characters) and SMTP secrets in the secret manager. Do not print secret values in logs or runbooks.
7. Run the focused tests and full required MySQL integration matrix in the release checklist. Capture evidence, including duplicate and failure-recovery cases, before proceeding.
8. Confirm the scheduler process is actually deployed, supervised, using UTC/expected clocks, and monitored. A schedule entry is not evidence of a live job.

## Staging validation sequence

Begin with one test organization and manually invoked, bounded runs. Start with the scheduler disabled for lifecycle modes; use the one-shot command only in staging and with a small batch. Example for a future staging run after gates are satisfied:

```sh
BILLING_LIFECYCLE_MODE=activate BILLING_LIFECYCLE_BATCH_SIZE=5 \
  BILLING_SUBSCRIPTION_ACTIVATION_ENABLED=true node scripts/run-billing-lifecycle-once.js
```

Repeat the same bounded procedure for `renewal-reminders` and `enforce-access` only after their individual validation is approved. A one-shot command still performs real database changes for its selected mode; it is not a dry-run. `run-billing-reconciliation-once.js` is a read-only audit for one `BILLING_RECONCILIATION_ORG_ID`, not a migration preview.

Validate, with synthetic staging data, that (a) an unpaid initial quote never grants credits; (b) exact-amount approved payment links one funded period; (c) activation grants once; (d) early renewal schedules from the current period end; (e) pending proof does not activate; (f) grace request alone does not extend access; (g) approved grace only changes the billing deadline; (h) expiry blocks operational requests while billing recovery remains available; (i) payment recovery does not clear manual/security suspension; and (j) repeated ticks/decisions do not duplicate periods, grants, or notifications. Check audit/ledger rows and user-visible state after each action.

Only after repeated staging cycles and recovery tests should the deployment owner decide whether to configure recurring scans. Before any recurring production processing or flag enablement, a separate release authorization and production change record are required.

## Phased rollout proposal

This sequence is a future proposal, not current authorization:

1. **Schema only:** apply the additive migration after backup/restore rehearsal; keep every new flag off.
2. **Shadow/reconciliation:** finish SUB-12; inventory and resolve all current organizations without changing balances or access. Explicitly mark tenants eligible for enforcement.
3. **Payment path pilot:** configure terms and payment review; pilot initial purchase/renewal with a small allowlist. Enable quote/purchase and proof/decision handling only after review of the shared flags' effect on top-ups/add-ons. Keep activation off until each financial approval case is validated.
4. **Funded activation/reminder pilot:** enable activation and reminder scans for the pilot. Verify credits and period linkage. Enable outbox plus separately supervised email delivery only after recipients and delivery evidence are tested.
5. **Grace pilot:** enable grace requests and platform decisions with an on-call reviewer and audit verification.
6. **Enforcement canary:** enable request-time and scheduled enforcement only for fully reconciled eligible tenants. The current gate is not proven to cover internal APIs, jobs, telephony, WebSockets, or active calls, so this phase is blocked until those paths are addressed.
7. **Expand:** expand by a reviewed cohort only after dashboards and alerts remain healthy through at least one renewal and expiry cycle.

Do not enable upgrade preview for customers until SUB-06 includes a transactionally applied effective-plan history consumed by workspace authorization and organization entitlements, target inventory validation, payment/approval fulfillment, a completed organization UI, downgrade handling, staging verification, and collision/retry tests. Adjustment payment acceptance remains hard-disabled in code; there is no flag that can turn on partial fulfillment.

## Monitoring and alert requirements

No subscription lifecycle dashboard/alert pack is implemented by this branch. Before rollout, add metrics and alert ownership for:

- scheduled tick success, duration, last-success time, scanned count, blocked/error count, and backlog age for activation, renewal reminders, and access enforcement;
- funded periods awaiting activation, activation failures, duplicate/idempotency conflicts, and any credit-grant/period-link invariant mismatch;
- payment reviews by status/age, amount mismatch, rejected/needs-information age, and approval outcomes;
- upcoming expiry cohort, unpaid at deadline, billing-restricted organizations, access-gate 5xx/missing-record failures, and organizations unexpectedly reactivated;
- grace requests by pending age, decisions, grants near/over expiry, and any deadline change without a matching approved decision;
- notification outbox ready/leased/retry/dead-letter age, email delivery success/failure/bounce, and events that have no delivery consumer;
- migration version/checksum, scheduler process health, and clock skew.

Use alert thresholds and paging policy agreed with finance/platform operations; do not infer healthy email from successful event enqueue. Avoid logging receipt contents, encryption keys, or payment secrets.

## Disable and rollback

To stop new behavior, set the relevant feature flag to anything other than the exact string `true` and restart/redeploy the affected API or scheduler process so the new environment is loaded. Disable in this order during an incident: access enforcement first if it is incorrectly restricting eligible customers; then activation and renewal reminders; then grace/purchase APIs; then payment submission/decision only if the broader shared payment flow is also intended to stop; finally outbox/email workers if notification handling is implicated. Follow the incident commander and finance decision, since disabling a flag does not reverse already-approved payments, active periods, issued credits, recorded grace, or audit history.

Do not drop the lifecycle tables or delete rows to “roll back.” The migration is additive and MySQL DDL is not fully transactional. Preserve quotes, payments, approvals, grants, decisions and event history; use a reviewed forward fix or explicitly audited corrective transaction for bad financial state. Do not manually flip `paid`, period, balance, subscription, or suspension columns. After disabling enforcement, verify the actual request path behavior and ensure manual/security suspensions still apply. If a scheduler tick is in flight, inspect its operation records and ledger before retrying.

## Current release disposition

**Not ready for production rollout.** The migration is registered but has not been applied by this work. No flags were enabled and no deployment or customer-facing financial operation was performed. SUB-06, SUB-12 and SUB-14 release evidence remain open; portions of SUB-08, SUB-11 and SUB-13 also remain open as listed above. Reassess this document after those gaps are closed and update it from the deployed configuration, not from assumptions.
