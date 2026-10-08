# Workspace postpaid policy (BILL-14)

The `postpaid` module provides an application policy service, a funding source
adapter, and a MySQL repository over the postpaid account, period exposure,
and postpaid journal
tables created by the billing foundation. It does not add a migration or
expose HTTP routes.

## Policy and authorization

`createPostpaidPolicyService()` exposes two transaction-backed commands:

- `setFundingMode` switches the organization fallback between `prepaid` and
  `postpaid`, with an optimistic `enforcement_version` check. The switch only
  affects new reservations; existing reservation lines, prepaid grants, and
  exposure totals remain intact.
- `setWorkspacePolicy` enables or disables a workspace's `limited` or
  `unlimited` postpaid mode, with an optional per-cycle amount for `limited`.
  It requires an authorization callback and a server-side eligibility resolver.

The resolver must return the effective purchased terms, service access state,
period ID, and billing asset/scale. Postpaid is unavailable unless the active
terms allow it and the selected workspace mode appears in
`terms.postpaid.workspaceModes`. No workspace policy row means disabled.

## Reservation and exposure behavior

When the organization fallback is `postpaid`, usage reservations consume
workspace allocated subscription credits first, then prepaid top-ups, then the
workspace's explicitly enabled postpaid source. Limited workspace policy and
organization exposure caps include settled exposure and open holds. The
organization exposure total spans periods, so renewal does not reset it.
Unlimited workspace mode skips only that workspace's own cap; any organization
cap still applies.

Postpaid reservation lines have a period source and no credit grant or position.
The reservation service holds workspace and organization exposure in the same
organization UnitOfWork as the reservation. Release returns those holds. BILL-15
will convert held exposure into posted debt and apply payments or reversals;
this task does not settle usage, create invoices, or collect money.

The funding resolver used by `createUsageReservationService()` supplies
`postpaidEligible`, `allowedPostpaidModes`, `postpaidPeriodId`,
`organizationExposureLimit`, and `postpaidAsset`/`postpaidScale` where no
configured cap supplies the asset and scale. It is trusted server-side data.

No provider integration, route enablement, deployment, or migration is part of
BILL-14.
