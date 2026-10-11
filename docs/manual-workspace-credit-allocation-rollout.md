# Manual workspace credit allocation — controlled rollout

## Delivered behavior

Billing & Usage → Allocation is organization-admin-only (Owner has equivalent financial authority).
The UI presents exact grant amounts, workspace balances, expiry, allocation previews, and
the most recent 50 organization-to-workspace transfer journal entries.

The backend has three endpoints:
- `GET /api/billing/manual-allocations` — tenant-scoped, read-only snapshot. Returns
  `uninitialized`, `writable`, `transfersEnabled`, `workspaces`, `balances`,
  `grants` and `history`. Available only to organization finance administrators.
- `POST /api/billing/manual-allocations/preview` — read-only, accepts exactly
  `{grantId, workspaceId, amountUnits, expectedPositionVersion}`. It rejects
  unauthorized/suspended targets, over-allocation, invalid amounts and stale versions.
- `POST /api/billing/manual-allocations/transfer` — exact `{grantId,workspaceId,amount,
  expectedPositionVersion}` plus required `Idempotency-Key` header. The server
  assigns the organization, authenticated actor, source and destination scope.

### Safety and accounting boundaries

1. Transfers are **disabled by default**. Only the exact environment variable
   `BILLING_MANUAL_ALLOCATION_ENABLED=true` permits the write route. Do not enable
   in production just to make the UI button clickable.
2. Payments must be approved and grants issued into the new organization billing
   credit ledger first. This UI never mints credits, uses legacy recharge wallets,
   or treats invoice/subscription fees as spendable credit grants.
3. Transfers call `createAllocationService().transfer()`, the existing
   `runFinancial` unit of work. It locks the organization account, validates
   the immutable grant (asset, expiry and active status), verifies the source
   position version and available-unheld units, and records balanced journal
   entries atomically with idempotency protection.
4. Workspace scope and organization identity derive from authenticated requests.
   Manual transfers can only move from the organization **pool** to an active
   workspace within the same organization; the API does not allow workspace-to-
   workspace transfers, workspace-to-organization returns, or arbitrary account IDs.
5. Credit amounts are transported as integer strings plus asset and scale. The
   frontend never sums different assets and never converts ledger units through
   floating-point Number.
6. The displayed preview is informative, not a reservation. A concurrent
   position change produces an explicit conflict and requires refresh/repreview.
7. Server authentication requires `billing.credit.allocate` **and** membership
   in Owner/Organization Admin; Workspace Admin, Billing Admin, Manager and Member
   cannot allocate. Source permission cannot be supplied by the client.

## Release gate (must be completed before enabling writes)

- Deploy backend and apply all existing billing migrations in staging; confirm
  new credit account/positions/journals and `account_purpose='pool'` are present.
- Seed realistic subscription and top-up grants through **approved** payment and
  subscription lifecycle flows. Validate against authoritative financial records;
  never insert fabricated production balances.
- Run a real MySQL integration flow with two organizations, at least two
  workspaces, held/expired/active grants, mixed credit assets, concurrent
  allocation attempts and idempotent retries. Assert account and grant conservation,
  expiry preservation, isolation, and balanced journals.
- Confirm last-write-wins cannot occur: the second request with a stale
  `expectedPositionVersion` should conflict; the same idempotency key and
  identical body should return the stored result.
- Verify financial reconciliation and that usage charging reads **workspace**
  credit positions rather than silently falling back to the shared legacy wallet.
- Perform security checks with Workspace Admin, Billing Admin, ordinary Member,
  Organization Admin, Owner, and cross-tenant workspace/grant IDs.
- Enable `BILLING_MANUAL_ALLOCATION_ENABLED=true` in a restricted staging
  deployment, exercise a small real transfer and verify the ledger and UI history.
- Obtain explicit operations/financial sign-off for production enablement.
  Do **not** switch this flag on without this gate.

## Future iteration (not activated)

Keep allocation of existing credits manual during phase one. Saved percentage/fixed
rules, automated distributions for incoming grants, reversals, and recurring balance
alerts should be integrated only after the staged financial transfer gate passes.
