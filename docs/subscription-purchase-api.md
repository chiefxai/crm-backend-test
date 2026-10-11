# Initial subscription purchase API (v1)

These endpoints are scoped to the authenticated organization in `req.orgId`; the client cannot choose the organization, plan, prices, allowance, or inventory. They remain unavailable unless `BILLING_SUBSCRIPTION_PURCHASE_ENABLED=true`. Quote creation also requires `BILLING_SUBSCRIPTION_QUOTE_TTL_SECONDS` from 60 to 604800. Payment submission stays controlled by its existing feature flags.

## Read the onboarding quote

`GET /api/billing/subscription-purchase`

Requires authenticated organization billing-admin role (`Owner`, `Organization Admin`, or `Billing Admin`) and `billing.read` permission. Returns the server-resolved onboarding state and quote, or 404 if initial onboarding is not provisioned.

```ts
type Amount = { asset: string; units: string; scale: number };
type InitialPurchaseResponse = {
  subscription: {
    lifecycleStatus: string;
    accessState: string;
    planId: string | null;
    planVersion: number | null;
  };
  quote: null | {
    quoteId: string;
    purpose: 'purchase';
    status: 'draft' | 'accepted' | 'paid' | string;
    version: number;
    plan: { id: string; version: number; terms: Record<string, unknown> };
    inventory: Record<string, unknown>;
    lines: Array<{ code: string; label: string; quantity: number; unitAmount: Amount; amount: Amount }>;
    subtotal: Amount;
    discounts: Amount;
    totalTax: Amount;
    paymentAmount: Amount;
    includedCredits: Amount;
    createdAt: string;
    validUntil: string | null;
    expired: boolean;
    payable: boolean;
  };
  payment: {
    submissionEnabled: boolean;
    purpose: 'subscription';
    submissionPath: '/api/billing/payments';
  };
};
```

`paymentAmount` is the plan fee plus any applicable workspace, seat, industry, tax, and adjustment quote lines. `includedCredits` is the separate plan allowance; it is not added to the payment amount and is not spendable until approved period activation.

## Provision or retry initial quote creation

`POST /api/billing/subscription-purchase/initial-quote`

Requires the same role and permission, an `Idempotency-Key` header, and an empty JSON body. The server reads the saved workspace-plan selection and actual org inventory, resolves the selected source version through the canonical published plan catalog, and creates the initial purchase quote. Repeating the same key is idempotent; a fresh key can create a replacement after quote expiry, preserving prior immutable quotes. The subscription onboarding record remains unique per organization.

The response is `InitialPurchaseResponse` with HTTP 201 on creation or 200 if already provisioned. Expected errors include 400 for a missing idempotency key/body fields, 403 for a non-billing-admin, 404 for a missing organization, 409 for absent/stale plan selection or conflicting onboarding, and 503 when the feature, catalog policy, or quote-expiry policy is unavailable.

Once `quote.payable` and `payment.submissionEnabled` are both true, submit the proof through the existing multipart endpoint `POST /api/billing/payments`. Its `command` JSON must contain `schemaVersion: 1`, `purpose: 'subscription'`, `quoteId: quote.quoteId`, `expectedAmount: quote.paymentAmount`, and `paymentReference`; the authenticated request supplies organization and actor scope. Attach the required `proof` file. Approval remains the platform-admin payment-review flow. A submitted receipt does not activate access or issue credits.

Release dependency: creating a new organization with initial purchases enabled requires explicit platform subscription terms and `BILLING_SUBSCRIPTION_ACCESS_ENFORCEMENT_ENABLED=true`. Reconcile existing organizations before enabling request-time access enforcement; missing subscription records fail closed when the gate is enabled. Keep purchase, payment submission/decision, lifecycle jobs, grace, and access enforcement flags off until the runbook prerequisites are met.
