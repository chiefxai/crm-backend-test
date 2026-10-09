# Billing and subscription completion — integration baseline

Status: implementation in progress; NOT production-ready.
Branch: feature/billing-subscription-completion
Baseline: main (the older feature/billing branch was one commit behind main in both repositories).

## Confirmed implementation inventory

Backend:
- src/billing/modules/subscriptions/lifecycleService.js
- src/billing/modules/subscriptions/periodActivationService.js
- src/billing/modules/subscriptions/periodJobs.js
- src/billing/modules/subscriptions/repositories/mysqlPeriodRepository.js
- src/billing/modules/payments/submissions.js and decisions.js
- src/billing/modules/credits/ and src/billing/modules/allocations/
- src/billing/adapters/jobs/ and src/billing/adapters/delivery/
- Existing tests under tests/billing/, including subscriptions/.

Frontend:
- src/lib/billing/client.ts
- src/admin/OrgBillingConsole.tsx
- src/admin/WorkspacePlansPage.tsx
- src/components/billing/

## Confirmed blockers

1. docs/billing-implementation-tasks.md assigns live route registration, event consumer registration, worker composition, and scheduler triggers to BILL-19. Verify current runtime wiring before marking this complete.
2. docs/billing-provider-lifecycle.md states credit enforcement is disabled by default, Vobiz/Gemini purchased credit-rate mappings are missing, and provider lifecycle adapters are not registered in live execution paths.
3. No passing cross-repository end-to-end test or production deployment evidence has yet been established.

## Execution order and gates

1. Audit existing registered routes, DTOs, auth policies, worker bootstrapping, migrations, and frontend callers. Produce an endpoint-to-handler compatibility matrix.
2. Implement missing BILL-19 wiring with scoped authorization, idempotency, and transactional consistency; add route tests.
3. Verify subscription purchase, manual approval, period activation, renewals, cancellation, and entitlements against real DB tests.
4. Integrate frontend screens with real APIs; test error/loading/permission states.
5. Wire provider funding only after purchased rates, reservation settlement, reconciliation, and legacy migration ownership are verified.
6. Implement and test reconciliation, migration, multi-worker recovery, and complete E2E acceptance.
7. Obtain separate release approval before applying production migrations, enabling credit enforcement, or sending customer emails.

## Safety requirements

- No financial mutations in production during development.
- No automatic payment approval or credit issuance on payment submission.
- No dual ledger ownership for migrated organizations.
- No claim of production readiness without passing financial invariants, role isolation, migration and worker recovery tests.
