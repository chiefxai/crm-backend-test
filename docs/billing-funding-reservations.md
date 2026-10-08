# Usage funding and reservations (BILL-13)

Status: funding domain and transactional adapters implemented. HTTP routes,
provider lifecycle hooks, postpaid exposure, settlement, and production
enforcement remain gated for their later tasks.

## Application contract

`src/billing/application/usageFunding.js` exports
`createUsageReservationService()`, whose caller supplies the billing UnitOfWork,
the reservation and credit repositories, an ID source and clock, an authorization
callback, and a transaction-scoped policy resolver. Its public commands are:

- `reserveUsage({ command, trustedContext })`: reserves `estimatedAmount` for a
  workspace, identified by `scope`, `usageOperationId`, and optional
  `sourceRevision` (default `0`), with a `pricingSnapshot` whose rated amount
  exactly matches the requested amount.
- `extendUsage({ command, trustedContext })`: adds `additionalAmount` and extends
  `validUntil`, requiring the current reservation version and a matching
  additional pricing snapshot.
- `releaseUsage({ command, trustedContext })`: releases all unconsumed held units,
  requiring the current reservation version.

`resolveFundingPolicy({ tx, orgId, workspace, service, now, billingAccount })`
must return an authoritative `serviceAllowed` flag, and can return a
`workspaceCycleCap`, `cyclePeriodId`, and period window. It is a server-side
resolver; clients cannot select the org fallback mode or cap. The service reads
the persisted organization billing account for fallback mode and policy version.
Authorization is a separate required callback. No routes or production
composition are enabled by this task.

## Funding rules

- Only active `pool` positions owned by the requested workspace are eligible.
  There is no implicit borrowing from the organization administrator pool.
- Eligible subscription grants are reserved first, in earliest-expiry order;
  prepaid top-up grants cover the remainder. Available units are balance minus
  all existing holds.
- A grant that expires before the reservation end is skipped. An extension is
  rejected if it would move an existing held subscription segment beyond that
  grant's expiry. Provider integration must split the operation at that boundary.
- `postpaid` organization fallback may use a workspace's explicitly enabled
  postpaid source after allocated subscription credits and prepaid top-ups.
  BILL-14 enforces workspace and organization exposure caps and records
  period-backed postpaid reservation lines.
- If a configured workspace cycle cap applies, existing posted credit consumption
  and all open reservation holds count against it. A cap denial returns
  `BILLING_WORKSPACE_LIMIT_REACHED`.
- All position holds, reservation headers and split reservation lines commit in
  one `runFinancial()` transaction. The organization billing row serializes
  concurrent funding operations; credit positions and reservation rows are also
  locked. Journaled reserve/release entries preserve ledger traceability.
  Accepted pricing snapshots are persisted with reservations and extensions, so
  later rate changes do not silently alter the authorized estimate.

## Typed denials

`BILLING_USAGE_NOT_ENTITLED`, `BILLING_INSUFFICIENT_CREDITS`,
`BILLING_WORKSPACE_LIMIT_REACHED`, `BILLING_POSTPAID_DISABLED`,
`BILLING_GRANT_EXPIRED`, `BILLING_RESERVATION_STATE_CONFLICT`, and
`BILLING_VERSION_CONFLICT` distinguish service, balance, cap, source, expiry,
state, and stale-policy/version denials.

The current schema is sufficient; this task adds no migration. Usage settlement
and reservation-line consumption are intentionally left for BILL-15. Provider
authorization/stop/recovery hooks remain BILL-16. No scheduler changes or backend
deployment are part of BILL-13.
