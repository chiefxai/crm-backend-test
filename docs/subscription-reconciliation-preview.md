# Subscription reconciliation preview

`GET /api/platform/billing/subscription-reconciliation/preview?limit=50&offset=0` is a platform-admin-only, read-only candidate inventory. `limit` is clamped to 1–100 and `offset` to 0–100000. It lists organization plan snapshots, lifecycle/billing-account presence, billing evidence counts, and legacy recharge balances as a separately labelled data point. It does not write data, set a paid state, calculate a historical price, create periods, create grants, or treat recharge balance as subscription credit.

The preview labels candidates as:

- `active_billing_evidence`: an active subscription period and active subscription grant are already present; verify that these records are correct before doing anything.
- `existing_billing_history_review`: billing/lifecycle records exist; reconcile their quote, payment decision/fulfillment, period, and grant relationships rather than creating duplicates.
- `legacy_plan_unverified`: no versioned organization plan snapshot exists. A current plan with a matching name is not proof of historical terms.
- `versioned_plan_no_billing_evidence`: a versioned plan selection is present, but that selection does not prove accepted terms, payment, or entitlement.

All classifications require human review. Before any future reconciliation write, an operator must independently verify the organization identity; source plan and its effective version; purchased quantity/seat/workspace scope; contractual price, taxes, currency, billing dates and payment terms; actual payment evidence and settlement; existing payment decisions and fulfillment; existing periods, grants and credit consumption; any manual suspension or access state; and the intended migration outcome. Conflicts, missing evidence, legacy balance ambiguity, and duplicate records must be escalated rather than guessed.

An approved write path still needs a separately reviewed design and implementation: an explicit platform-admin approval with reason and evidence reference, idempotent command and concurrency checks, immutable audit trail, links to verified quote/payment/period history, duplicate prevention, credit-grant rules that do not duplicate consumed or active credits, dry-run diff plus confirmation, and rollback/compensation guidance. This preview does not provide that write path, and should not be treated as authorization to allocate credits or activate a subscription.
