# Workspace add-on purchases and renewals

The plan's `includedWorkspaces` includes the default workspace. A plan with five
included workspaces and `extraWorkspaceMonthlyInr: 50` permits five immediate
workspaces. Workspace six requires a ₹50 add-on fee, payable through an approved invoice or eligible top-up credits. `maxWorkspaces` is
the separate hard maximum; pending purchases reserve capacity within it. The
platform workspace cap still applies when the plan maximum is null.

## Purchase

The organization owner/admin chooses an invoice or the unallocated top-up credit
option from Settings → Workspaces. Prices are always validated against the
server's existing plan quote and workspace capacity. No client-provided price or
balance is trusted.
The owner, organization admin, or billing admin uploads a bank/UPI receipt using
the existing invoice payment endpoint. Payment Reviews must approve the entire
quoted amount. Approval, invoice settlement, workspace provisioning, membership,
and add-on activation commit in one financial transaction. Any failure rolls
back the decision. Idempotency and unique invoice/cycle keys prevent duplicate
provisioning. Platform workspace creation cannot bypass payment.

### Optional instant top-up credit redemption

With `BILLING_WORKSPACE_TOPUP_REDEMPTION_ENABLED=true`, an authorized organization
billing administrator can pay the **first** add-on month with existing unallocated
organization-owned top-up grants instead of waiting for receipt approval.
This does **not** spend monthly subscription grants, credits already allocated to
workspaces, held credits, or the legacy recharge wallet. The exact fee is charged
at ₹1 per INR-denominated top-up credit of equal scale, using integer paise.

The API `POST /api/billing/workspace-addons/pay-with-topup` requires the same
permissions and idempotency key as a standard add-on purchase. It validates the
workspace and acceptance token, creates the invoice, journals top-up consumption
to `workspace_fee_clearing`, marks the invoice paid, and provisions the workspace
in one serialized financial transaction. A failed debit or provisioning rolls
back everything; a replay with the same key cannot charge twice. The invoice
history identifies top-up redemption by its source journal and payment key.
Insufficient unallocated top-up credits returns HTTP 402 with no workspace and
no deduction. No manual payment verification is needed *for this already-funded
credit redemption*. A separate invoice remains available as a fallback.

The feature is opt-in pending accounting/legal review: top-up credits previously
represented usage only. Operators must approve the updated customer terms before
enabling their redemption for subscription fees. This is not a withdrawal or
transferable cash balance, and it must not be described as cash in the UI.


Unsubmitted purchases expire after 24 hours. A submitted receipt reserves its
slot until review is resolved. Pending purchases can be cancelled before a
payment is awaiting review. Rejected receipts can be replaced with a new
submission; clarification requests use the original payment request identifier.

## Renewal

Each workspace add-on has its own monthly anniversary starting on initial
payment approval. Dates use UTC calendar months and preserve the original day,
including January 31 → February 28 → March 31. Its configured monthly price is
snapshotted at purchase. Seven days before expiry the scheduler issues an
organization-owned renewal invoice and a billing notification. Email delivery
uses the existing billing email delivery worker/configuration.

Renewal means automatically issuing invoices, **not automatically debiting
usage credits or a payment card**. The existing manual payment verification flow
settles renewal invoices. Only the optional first-month top-up redemption reduces
available usage top-up credits; the remainder stays available for usage. No cash
wallet or payment provider mandate is implied.

Early payment extends the existing anniversary. Unpaid access ends seven days
after the paid period ends. Authorization checks the expiry directly, so an
overdue add-on cannot remain usable because the scheduler was delayed. The
scheduler suspends its operational workspace without deleting data. Billing
administrators retain access to billing with no operational workspace role.
Paying after grace starts a fresh month; suspended months do not accumulate
invoices. Only a suspension marked by billing is undone by payment.

Customers can stop renewal. Any unpaid invoice is voided when there is no
payment under review, and access ends at the last paid expiry. Renewal can be
enabled again to generate a new payable invoice. Separately billed workspaces
remain in structural inventory, and catalog subscription quotes exclude their
workspace fee to avoid charging twice. Callers must use the persisted
`billingAddonId`/`settings.billingAgreement` when building catalog inventory.

## Existing extras and deployment

Migration `2026100722_workspace_addon_purchases` creates the add-on tables and
registers existing extra workspaces with a seven-day payment grace period.
Their data and memberships are preserved. This adoption requires a billing
account; legacy organizations awaiting a reconciled ledger migration still
need that migration first. Existing extras in those organizations are not
automatically converted by this migration. New unpaid extras are blocked.

Deploy backend migrations and restart both API and scheduler before the updated
frontend. Existing feature flags must be enabled:

```dotenv
MULTI_WORKSPACE_ENABLED=true
WORKSPACE_ISOLATION_VERIFIED=true
BILLING_PAYMENT_SUBMISSION_ENABLED=true
BILLING_PAYMENT_DECISION_ENABLED=true
# Optional; only after top-up redemption terms/accounting approval:
BILLING_WORKSPACE_TOPUP_REDEMPTION_ENABLED=true
```

The receipt storage credentials used by the existing payment flow must be
configured. The VM scheduler runs `workspace-addon-renewals` every five minutes
in bounded batches of 100. Other scheduler providers must invoke that registered
schedule with their existing dispatch mechanism. Paused or disabled payment
review does not make unpaid workspaces usable. Keep payment review enabled
while offering workspace add-ons.

Local checks cover payment gating, capacity reservations, full invoice payment,
renewal dates, overdue suspension, inventory ownership, and invoice rendering.
The migration and receipt approval should also be exercised against the VM's
MySQL deployment before releasing purchases to customers.
