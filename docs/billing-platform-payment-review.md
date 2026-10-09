# Platform payment decision API — disabled-by-default release gate

The platform operator endpoint is:

`POST /api/platform/billing/organizations/:orgId/payments/:paymentRequestId/decision`

It is mounted within the existing platform router, which runs `requireAuthIdentityOnly` and `requirePlatformAdmin` before any operator endpoints. The financial service additionally checks the verified platform-admin identity, authenticated user ID and target-organization binding.

## Enablement

- `BILLING_PAYMENT_DECISION_ENABLED` must be exactly `true`. Unset or any other value fails closed with HTTP 503.
- This flag must remain **unset in production** until approval and fulfillment tests, reconciliation, and migration reviews pass.
- The request must include `Idempotency-Key`; retries of one user action must reuse the same key.
- The organization must have a healthy `organization_billing_accounts` record and the applied billing schema.
- Do not enable until transactional outbox delivery and subscription period activation are composed and tested in staging.

## Request

JSON body:

```json
{
  "decision": "approve",
  "expectedVersion": 1,
  "receivedAmount": { "asset": "INR", "units": "10000", "scale": 2 }
}
```

`approve` requires `receivedAmount` exactly matching the verified expected amount; `reject` and `request_clarification` require a reason. The user cannot specify `orgId`, `paymentRequestId`, actor, or trusted operation context in the JSON body.

Service-layer approval performs quote validation and decision recording in a serialized financial transaction. Subscription purchases schedule a funded period; top-ups create a credit grant; invoices apply payment. These actions are only triggered by **platform decision approval**, never by customer payment submission.

## Required stage-gate tests (not yet executed)

1. Run unit tests for the payment decision service, period lifecycle, credit repository, invoice payments, and outbox.
2. Test HTTP 401 / 403 for unauthenticated users, organization billing admins, and spoofed identities; test 503 with disabled flag.
3. Run staging integration tests with manually submitted real-format proof and verified operator approval across subscription, top-up, and invoice paths.
4. Verify stale expected version returns 409, idempotent retry returns original result, conflicting retry returns 409, and duplicate approval does not double-fund.
5. Test cancellation, subscription activation worker, credit allocation, invoice settlement, outbox worker retries and reconciliation.
6. Ensure receipt access and audit evidence controls meet operator review policy.
7. Verify frontend build and end-to-end operator workflow; obtain a separate release approval before enabling financial flags.

Status: API and frontend client committed; **not production ready**.
