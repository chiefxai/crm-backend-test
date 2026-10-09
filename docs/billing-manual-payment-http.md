# Manual payment submission API (feature gated)

Endpoint: `POST /api/billing/payments` (multipart/form-data).

This is a **manual payment proof submission** route. It does not approve a payment, activate a subscription, issue credits, or settle invoices.

## Rollout configuration

- `BILLING_PAYMENT_SUBMISSION_ENABLED=true` enables the route. **Unset / all other values disable it** (503, `BILLING_PAYMENT_SUBMISSION_DISABLED`).
- The private S3-compatible proof store must be configured with `STORAGE_BUCKET` and storage client credentials.
- Billing schema migrations and `organization_billing_accounts` must exist for the organization.
- Successful use requires a verified authenticated organization role of Owner, Organization Admin, or Billing Admin and the `billing.read` permission.
- **Do not turn on the flag in production** until payment submission and organization-isolation integration tests pass and a deployment review is approved.

## Request format

Headers: `Authorization: Bearer <token>`, `Idempotency-Key: <stable-per-action-key>`.

Multipart fields:

- `command`: JSON object containing `purpose` (subscription/topup/invoice), `expectedAmount` ({ asset, units, scale }), `paymentReference`, and `quoteId` or `invoiceId`; optional `payerNote`, `paymentRequestId` (for supported resubmission).
- `proof`: required PDF/JPEG/PNG/WEBP with a verified binary signature, maximum 10 MiB.

Do not send `orgId`, actor, context or receipt storage key: the server assigns trusted metadata. The server validates payment amount against a quote or invoice inside a financial transaction.

HTTP 201 returns the frontend's `PaymentRequest` response shape with `pending_verification` status. Duplicate or stale writes return 409 where applicable. A payment is **never approved** by this route.

## Verification requirements

1. Run `node --test tests/billing/paymentSubmissionHttp.test.js` and billing repository/UoW tests.
2. Exercise real multipart requests against a migrated test organization and a configured private object store.
3. Verify role denial (403), absent proof (400), file-size rejection (413), invalid idempotency (400), duplicate request replay, conflicting replay (409), cross-tenant proof access, and no credit issuance on submission.
4. Reconcile proof objects and transaction records on failed submissions.
5. Verify receipt lifecycle, approval decisions, and platform-admin separation before enabling customer payments in production.

The frontend's legacy JSON `billingClient.submitPayment()` does not use this upload contract; use `billingClient.submitPaymentWithProof()` for this endpoint. The JSON helper must be migrated/removed after checking callers.
