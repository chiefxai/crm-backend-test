# Subscription grace API

Grace workflows are disabled unless `BILLING_SUBSCRIPTION_GRACE_ENABLED=true` is set. A request never changes access. One request is allowed for each billing period by the lifecycle schema's unique constraint. The default policy caps a request/grant at seven days past the later of the period end and current billing restriction deadline.

Organization billing administrators can read their requests and create one for the current period:

- `GET /api/billing/subscription-grace-requests?status=all` (includes server-computed eligibility, subscription version, current deadline and maximum allowable date)
- `POST /api/billing/subscription-grace-requests`

The POST body contains `periodId`, `requestedUntil`, `justification`, and the current `organization_subscriptions.version` as `expectedVersion`. Supply an `Idempotency-Key` header. Organization and actor identity are always taken from the authenticated request.

Platform administrators can review the queue and decide:

- `GET /api/platform/billing/subscription-grace-requests?status=requested`
- `POST /api/platform/billing/organizations/:orgId/subscription-grace-requests/:graceRequestId/decision`

Decision bodies contain `decision` (`approve` or `deny`), `reason`, `expectedVersion` from the request, and optionally `grantedUntil` for approvals. The granted time must be later than the current billing deadline, within policy maximum, and no later than the organization's requested time. Every decision is appended to `billing_subscription_grace_decisions`. An approved deadline is persisted for the lifecycle scanner; it can restore only billing-caused suspension. Manual and security suspensions remain in force.
