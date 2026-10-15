# Single-workspace automatic credit allocation — task breakdown

Source: `Chief Connect CRM — Implementation Plan: Automatic Credit Allocation for Single-Workspace Subscriptions`.

## Scope and activation boundary

Implement subscription-aware allocation using the current credit ledger. A subscription
whose effective `terms.structure.maxWorkspaces` is exactly `1` uses automatic
allocation. A multi-workspace or unlimited plan keeps administrator-controlled
allocation, even when the organization currently has one workspace.

This task list authorizes code and test work only. Automatic allocation must remain
inactive for customer organizations until there are real ledger accounts and grants
to validate, the staging financial checks pass, and the release owner explicitly
enables the feature. Automatic financial transfers require both
`BILLING_AUTOMATIC_ALLOCATION_ENABLED=true` and an explicit organization ID in
`BILLING_AUTOMATIC_ALLOCATION_ORG_IDS`; keep both unset for this implementation.
Do not change or enable `BILLING_MANUAL_ALLOCATION_ENABLED`.
Do not deploy, migrate production, or run reconciliation against production data.

## Ordered implementation tasks

### AUTOALLOC-01 — Resolve allocation mode from effective subscription terms

Dependencies: none. Own: backend allocation-mode resolver and focused unit tests.

- Read the effective, authoritative subscription terms; never accept frontend mode
  or infer mode from the current workspace count.
- Return mode, workspace capacity, manual-allocation capability, and readiness.
- Resolve exactly one eligible active destination workspace for a single-workspace
  plan. Missing or inconsistent terms/workspaces must fail closed as not ready.
- Treat a multi-workspace or unlimited capacity as manual mode.

Acceptance: single, multi, unlimited, missing terms, inactive/multiple workspaces,
and capacity/inventory conflicts have deterministic outcomes.

### AUTOALLOC-02 — Expose capability and enforce manual allocation applicability

Dependencies: AUTOALLOC-01. Own: backend billing overview and manual-allocation
read/preview/transfer routes plus API tests.

- Add allocation capability to `GET /api/billing/overview` without replacing fields.
- Reject manual allocation reads that reveal actionable allocation controls,
  previews, and transfers when effective capacity is one.
- Preserve Owner/Organization Admin authorization and the existing manual transfer
  write flag. Unknown capability must not enable a write.

Acceptance: single-plan manual operations return a stable domain error; multi-plan
operations retain current permissions and the transfer flag remains off by default.

### AUTOALLOC-03 — Ledger-backed automatic transfer service

Dependencies: AUTOALLOC-01. Own: backend automatic transfer service and financial
integration tests.

- Reuse the financial UnitOfWork, allocation ledger transfer invariants, grant ID,
  positions, reservation handling, and append-only journals.
- Transfer only available, unreserved amounts; preserve kind, asset, scale,
  expiration, and grant provenance.
- Use deterministic operation IDs and retry/concurrency-safe idempotency.
- Use a trusted system actor/path; never invoke the admin-only HTTP route.

Acceptance: conservation, tenant isolation, held balances, expiry, duplicate calls,
and concurrent transfers are validated with a real database for concurrency claims.

### AUTOALLOC-04 — Subscription grant issuance and renewal integration

Dependencies: AUTOALLOC-03. Own: subscription purchase/activation compositions and
tests for new periods, renewals, trials, and paid trial conversion.

- Automatically transfer eligible grants after issue for single-workspace terms.
- Keep multi-workspace grants in the organization pool.
- Preserve early paid-trial credit timing and prevent duplicate grant/allocation.
- Keep issuance and transfer within the existing financial transaction where
  supported; otherwise represent incomplete allocation explicitly for safe retry.

Acceptance: retries do not duplicate funding, effective dates and expiry are
preserved, and each grant is allocated according to its own purchased terms.

### AUTOALLOC-05 — Approved top-up integration

Dependencies: AUTOALLOC-03. Own: payment decision composition and tests.

- Automatically transfer approved top-up grants for single-workspace plans in the
  payment financial transaction.
- Keep top-ups in the organization pool for multi-workspace plans.
- Preserve approval authorization, amount verification, top-up non-expiration, and
  existing idempotency behavior.

Acceptance: grant creation and transfer are atomic; failed transfer cannot be
reported as successfully distributed; repeated approval cannot duplicate credits.

### AUTOALLOC-06 — Reconciliation preview and safe retry

Dependencies: AUTOALLOC-03. Own: reconciliation service/command and runbook.

- Provide dry-run reporting for eligible unallocated subscription and top-up
  balances, destination, holds, and skip/failure reasons.
- Execute only ledger transfers, with deterministic idempotency and retry support.
- Never move workspace-owned balances or bypass reservation/expiry checks.

Acceptance: dry-run makes no writes; repeated execution is harmless; totals before
and after conserve value; production execution remains a release operation.

### AUTOALLOC-07 — Billing UI capability and workspace balances

Dependencies: AUTOALLOC-02 and the workspace billing read API. Own: frontend
Billing & Usage navigation, allocation/credits screens, client types and regression
tests.

- Hide Allocation and its shortcuts for single-workspace subscriptions; preserve it
  for authorized admins on multi-workspace subscriptions.
- Fail closed while capability is loading or unavailable; direct allocation URLs
  show an unavailable state or redirect to Credits.
- Show actual workspace subscription/top-up balances for automatic mode, while
  retaining the existing activity table and multi-workspace organization pool view.

Acceptance: no single-plan page implies credits are zero just because the pool is
empty; role and loading/error behavior are covered.

### AUTOALLOC-08 — Transition behavior and release validation

Dependencies: AUTOALLOC-01 through AUTOALLOC-07; plan-change fulfillment remains a
separate dependency where unavailable.

- Single-to-multi: stop future automatic transfers and preserve workspace funds.
- Multi-to-single: block unsafe changes until workspace inventory, holds, and
  balances are reconciled; never sweep another workspace automatically.
- Run staging ledger tests, dry-run reconciliation, review financial totals, and
  document monitoring/pause/rollback steps.
- Do not activate for customer organizations without real accounts/grants and the
  release gate described in the source plan.

Acceptance: unsupported upgrade fulfillment remains clearly identified; all
financial invariants pass before any rollout; no production enablement is included
in this implementation task.

## Progress

- [x] Task breakdown created before implementation.
- [x] AUTOALLOC-01 — resolver and overview capability projection.
- [x] AUTOALLOC-02 — capability API and manual-operation enforcement (focused read-model and resolver tests; HTTP test requires a local listener unavailable in this sandbox).
- [x] AUTOALLOC-03 — automatic ledger transfer service (mocked ledger tests; real-MySQL concurrency validation remains in AUTOALLOC-08).
- [x] AUTOALLOC-04 — subscription activation and free-trial issuance integration (default-off; lifecycle conversion coverage remains in AUTOALLOC-08).
- [x] AUTOALLOC-05 — approved top-up integration (default-off; approval DB integration coverage remains in AUTOALLOC-08).
- [x] AUTOALLOC-06 — read-only dry-run and deterministic per-grant retry command (actual execution still allowlist-gated).
- [x] AUTOALLOC-07 — frontend capability and balances.
- [ ] AUTOALLOC-08 — transitions and staged release validation.

### Remaining AUTOALLOC-08 gate

- The existing paid subscription adjustment/upgrade path still rejects fulfillment
  with `UPGRADE_ENTITLEMENT_INTEGRATION_NOT_IMPLEMENTED`; do not imply plan
  transitions are complete.
- Real-MySQL concurrency, reconciliation totals, and staging transfer checks need
  actual test accounts and approved grants. No production account or grant was
  inspected or changed for this task.
- Keep `BILLING_AUTOMATIC_ALLOCATION_ENABLED` and
  `BILLING_AUTOMATIC_ALLOCATION_ORG_IDS` unset. The reconciliation command is
  read-only unless both controls explicitly authorize that organization:

  ```sh
  node scripts/reconcile-single-workspace-credits.js --org-id <organization-id>
  ```

  An execution run uses `--execute` only after the staging release gate is passed.
