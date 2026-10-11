# Organization subscription renewal API

Renewal reads and quote creation are mounted under `/api/billing` and remain disabled unless `BILLING_SUBSCRIPTION_PURCHASE_ENABLED=true`. The endpoints require the authenticated organization and an `Owner`, `Organization Admin`, or `Billing Admin` role. Client input cannot choose the organization, plan, or amount.

- `GET /api/billing/subscription-renewal` returns the subscription version/access deadline, current period, renewal eligibility, current quote and pending-payment state.
- `POST /api/billing/subscription-renewal/quote` creates or returns the immutable renewal quote. Send an empty JSON body and a fresh `Idempotency-Key` header when creating a new quote. It is available during `renewalNoticeDays` before period end and after expiry. An unexpired quote is reused; pending payment or an already scheduled renewal blocks another quote.

Payment proof is submitted through the existing `POST /api/billing/payments` endpoint with `purpose: "subscription"` and the returned `quoteId`. Payment approval remains under the existing platform review flow and period activation. No separate renewal payment channel is introduced. Payment submission/decision feature flags remain independent and disabled until operations enables them.
