# Billing implementation task backlog

Progress: BILL-07 through BILL-18 have backend modules or foundations implemented. BILL-16 provider enforcement remains explicitly disabled pending purchased credit rates and BILL-19 composition. BILL-19 still owns route registration, event-consumer registration, worker composition and scheduler triggers.
Architecture authority: [billing-credits-architecture.md](billing-credits-architecture.md).
Backend: /Users/sanjay/Documents/chiefxai/crm-backend-test
Frontend: /Users/sanjay/Documents/chiefxai/com-frontend-test

## Assignment rules

Give an agent one task ID at a time. Dependencies must be completed and their
contracts available before starting dependent work. Independent tasks may run
concurrently only when their owned files do not overlap. Do not interpret every
task in a wave as independent; follow each task's dependencies.

Each task must deliver working code, appropriate meaningful verification, and a
short handoff listing files, public contracts, checks, limitations and next steps.
Implementation tasks may add focused tests for financial invariants; do not rely
on mocked balance arithmetic alone for database concurrency claims.

Keep new financial enforcement and customer deliveries disabled until the release
gate. Do not deploy, apply production migrations, send real emails, approve real
payments or push shared main as part of an individual task. Those actions belong
to the release task and require the coordinating user's authorization. This
backlog is an assignment document; it does not itself perform those actions.

For shared-file changes, provide an integration patch in the handoff. Only the
integration owner edits migrations/index.js, routes/index.js, authorization policy,
scheduler definitions, composition.js, App.tsx and admin navigation while other
agents are working. Integration tasks wire completed modules into those files.
Do not use task-local fake implementations in production composition.

For concurrent work use isolated branches/checkouts and merge in dependency order.
If agents share a checkout, run tasks with shared-file ownership sequentially.
No agent should revert another agent's changes.

## Wave A: contracts and persistence foundations

### BILL-01 — Shared domain values and command contracts

Dependencies: none. Own: src/billing/kernel/, contracts/, ports/.

Implement exact amount arithmetic with decimal-string transport, explicit asset
and scale, IDs/scope validation, clock contract, typed errors, operation context,
versioned event envelope and UnitOfWork/repository interfaces. Define validated
DTOs for payments, periods, grants, allocation, usage funding and postpaid limits.
Preserve existing CommonJS conventions. Publish an interface inventory and example
payloads for dependent tasks. No external providers or database writes.

Acceptance: invalid/overflow/mixed-asset values fail; fractional INR converts
exactly; idempotency includes request fingerprint; null/zero/disabled postpaid
states are distinct; DTO validation does not trust client actor/organization role.

### BILL-02 — Financial schema and migration registration

Dependencies: BILL-01. Own: new versioned billing migrations and schema reference
doc; integration owner registers migrations and scope classification.

Translate architecture tables into additive MySQL DDL, including operation-result
and consumer-inbox persistence. Supply explicit keys/indexes/ownership constraints,
receipt references, clearing positions for batched allocation and effective terms.
Choose migration identifiers after checking the current repository. Preserve old
migration checksums and prohibit cascading deletion of financial history.

Acceptance: migrations retry safely; applied historical steps are unchanged;
ownership/unique constraints support stated invariants; deployed MySQL compatibility
is documented; fresh and existing database migration paths are covered.

### BILL-03 — Transaction unit of work and command idempotency

Dependencies: BILL-01, BILL-02. Own: adapters/mysql/unitOfWork*, operation repository.

Implement per-org financial lock, consistent lock order, bounded deadlock retry,
expected-version checking, stored command result and transactional outbox append.
Pass transaction handles to repositories; no SMTP/provider calls under locks.

Acceptance: duplicate same-body requests return the same result; changed-body keys
conflict; concurrent mutations conserve balances; failure rolls back journal,
balances, result and outbox together. Verify concurrency using a real database.

### BILL-04 — Durable job claims, outbox and inbox

Dependencies: BILL-01, BILL-02. Own: adapters/mysql/outbox*, inbox*, jobClaims*;
adapters/jobs/worker*.

Implement leased claims, fencing tokens, retry/backoff, dead-letter state,
consumer deduplication and bounded fair batches. Define worker entrypoint and
dispatch registry without changing scheduler definitions yet.

Acceptance: worker restart recovers work; stale lease cannot finalize newer work;
duplicate events do not repeat transactional side effects; one org backlog cannot
consume all batch capacity. Email exact-once delivery is not claimed.

## Wave B: purchased terms, grants and payments

### BILL-05 — Plans, quotes and entitlement resolver

Dependencies: BILL-01, BILL-02, BILL-03. Own: modules/catalog/ and its repositories.

Implement draft/published immutable plan versions, effective org overrides,
itemized purchase/renewal quotes and deterministic entitlement decisions. Include
single/same-industry/mixed structure, workspace and distinct-industry fees,
included credits, taxes, postpaid eligibility and service-after-expiry policy.

Acceptance: plan edits cannot change purchased history; quotes are versioned;
primary-industry org-admin restriction holds; downgrade conflicts are reported;
payment amount is not automatically treated as credit value.

### BILL-06 — Subscription periods and lifecycle

Dependencies: BILL-03, BILL-05. Own: modules/subscriptions/ and repositories.

Implement anniversary periods, preserved anchor day, timezone/UTC boundaries,
scheduled paid renewals, late-renewal preview, cancellation and activation states.
Support separately anchored no-subscription postpaid periods.

Acceptance: no overlap; reads never roll financial periods; early renewal preserves
current cycle; short months/timezones are deterministic; period dates come from
purchased subscription data; unfunded periods cannot activate.

### BILL-07 — Credit grant ledger and transfers

Dependencies: BILL-03. Own: modules/credits/ and credit repositories.

Implement grant/account/position primitives: issue, transfer, reserve, consume,
release, expire and reverse. Balanced append-only journals, provenance and
transactional positions are mandatory. Include allocation-clearing accounts.

Acceptance: transfers preserve expiry; no transfer of spent/held units; grants
conserve total value; release never mints credits; expired funds cannot become
available again; duplicate operations are harmless.

### BILL-08 — Payment submission and private proof storage

Dependencies: BILL-03, BILL-05, BILL-06. Own: modules/payments/submissions*, proof
storage adapter and payment request repositories.

Implement subscription/top-up/invoice payment requests, reference normalization,
duplicate-reference warnings, clarification/resubmission and private receipt
upload/download authorization. Validate content/size and quote ownership.

Acceptance: submissions cannot approve themselves or issue credits; workspace
users cannot access org payment proofs; receipts are private; unexpected amounts
and stale quotes are visible and cannot silently fulfill a purchase.

### BILL-09 — Manual approval and payment fulfillment

Dependencies: BILL-06, BILL-07, BILL-08. Own: application/confirmPayment*,
modules/payments/decisions*, adapters/payments/manual*.

Implement authenticated platform approval/rejection and immutable decisions;
top-up grants, funded scheduled periods and notification events. Define payment
verifier boundary for a future gateway. Invoice payment fulfillment plugs into
BILL-15; reject that purpose until its real handler is wired.

Acceptance: one approval funds once, even concurrently; pending/rejected requests
issue nothing; invalid allocations cannot undo valid payment approval; success
message distinguishes scheduled credits from active credits.

### BILL-10 — Allocation rules, manifests and manual distribution

Dependencies: BILL-05, BILL-07. Own: modules/allocations/ and repositories.

Implement separate subscription/top-up rule versions, fixed amounts/percentages,
preview, manual allocation/return/transfer and idempotent grant allocation runs.
Persist manifest/held clearing balance for large runs; small runs may be atomic.

Acceptance: percentages use original grant; rounding remainder stays with admin;
invalid rules retain grant unallocated; suspended shares are skipped; future rule
edits do not mutate runs; batched retries and cancellation conserve grants.

### BILL-11 — Activation, expiry and renewal jobs

Dependencies: BILL-04, BILL-06, BILL-07, BILL-09, BILL-10. Own: application/activatePeriod*,
adapters/jobs/period*, expiry*.

Implement due-period activation, admin grant creation followed by allocation work,
expiry accounting and due renewal-event production. Scheduler wiring comes later.

Acceptance: repeat scans are safe; unfunded periods do not activate; timestamps
block expired credits independently of job punctuality; scheduled activation uses
the approved period and the documented allocation-rule version.

## Wave C: usage and postpaid

### BILL-12 — Usage inventory, rating adapters and immutable events

Dependencies: BILL-01, BILL-05. Own: adapters/usage/ metering/rating adapters,
modules/funding/usageEvents*, billable-path inventory document.

Inventory outbound/inbound providers, voice AI, post-call AI and non-call AI.
Define operation/component/revision IDs; normalize immutable priced events from
existing cost snapshots; distinguish estimated reports from payable usage.

Acceptance: every billable path has an owner/integration status; retries cannot
double-charge components; historical prices stay fixed; self-managed provider
estimates are excluded from payable usage. List unsupported paths explicitly.

### BILL-13 — Shared funding planner and reservations

Dependencies: BILL-03, BILL-06, BILL-07, BILL-12. Own: modules/funding/planner*,
reservations*, application/reserveUsage*, extendUsage*, releaseUsage*.

Implement subscription-first funding chains, split-grant reservation lines,
prepaid top-up fallback, overall workspace cap and typed denial responses.
Define postpaid-source contract; return unavailable until BILL-14 is wired.

Acceptance: all limits include holds; active/expired grants are distinguished;
concurrent reservations cannot overspend; reserved pricing/policy is snapshotted;
no organization-pool borrowing without allocation.

Status: complete. Planner, reservation application service, and MySQL
reservation adapter are implemented. No HTTP/provider integration or deployment.

### BILL-14 — Postpaid exposure and workspace policy

Dependencies: BILL-03, BILL-05, BILL-06, BILL-13. Own: modules/postpaid/exposure*,
policy*, funding source adapter.

Implement platform eligibility, org-admin workspace enablement, limited/unlimited
cycle settings, org cycle caps and persistent outstanding-debt exposure. Support
subscription -> postpaid funding and explicit funding-mode changes.

Status: complete. Domain policy, optimistic policy/fallback-mode commands,
MySQL exposure repository, and postpaid reservation fallback are implemented.
No deployment or migration until the release task.

Acceptance: disabled is default; unlimited workspace never bypasses org caps;
renewal does not erase outstanding debt; limits count holds; changing mode leaves
existing reservations/top-ups/debt intact.

### BILL-15 — Charge settlement, adjustments and invoices

Dependencies: BILL-07, BILL-09, BILL-12, BILL-13, BILL-14. Own:
application/settleUsage*, modules/postpaid/invoices*, charge revisions/payment
application and repositories.

Implement actual settlement and late-cost delta revisions, separate debt journals,
cycle invoice close, workspace itemization, invoice partial payment, due dates,
credit notes and audited reversals/overruns. Register real invoice fulfillment.

Status: transactional usage settlement, delta revisions and overruns, invoice
close/itemization, credit-note command, and manual invoice-payment fulfillment
implemented. Stop here for user approval before BILL-16; do not deploy or
migrate until the release task.

Acceptance: consumption and debt have distinct books; each component/revision is
posted once; late events are traceable after invoice close; payment reduces debt
without issuing credits; reversal cannot recreate expired credits.

### BILL-16 — Telephony/AI integration and reservation recovery

Dependencies: BILL-11, BILL-12, BILL-13, BILL-14, BILL-15. Own: adapters/usage/
provider lifecycle, adapters/legacy/recharge*, recovery jobs; integration owner
applies hooks in callFinalizer, vobizProxy, geminiUsageTracker and other inventoried paths.

Implement the injectable provider lifecycle adapter and expired-reservation
recovery scanner. Provider wiring, scheduling, and enforcement remain disabled
until a purchased credit-rate policy and application billing runtime are
configured. Preserve original engine ownership for legacy in-flight
reservations. Reconcile provider state before release.

Status: lifecycle adapter and recovery engine implemented. Live Vobiz/Gemini
hooks and scheduler registration are still gated: current integrations expose
INR estimates only, and no purchased credit-rate mapping or app-level billing
runtime is configured. The explicit restriction is documented in
`docs/billing-provider-lifecycle.md`.

Acceptance before enabling enforcement: retries, provider disconnects, delayed
costs and period boundaries cannot lose charges or reuse expired funding;
unsupported provider enforcement stays disabled with an explicit rollout
restriction.

## Wave D: notifications and server integration

### BILL-17 — Contacts, threshold policy and persistent feed

Dependencies: BILL-03, BILL-04, BILL-06, BILL-10, BILL-14. Own:
modules/notifications/ policies, contacts, threshold state and feed repositories.

Implement verified contacts, per-recipient read state, amount/percentage threshold
evaluation, OR behavior, recovery/hysteresis and cooldown. Cover workspace/admin
credits, fallback transition, postpaid exposure, payment and allocation events.

Acceptance: org/workspace audiences are isolated; unlimited limits have no invalid
percentage divisor; holds affect available balances; logical alerts deduplicate;
transfers and recovery re-arm correctly.

Status: verified-contact lifecycle and verification outbox event, versioned
notification policies, amount/percentage OR thresholds, high/low directions,
hysteresis/cooldown, persistent notifications and per-recipient read state are
implemented. Additive contact-verification expiry migration is registered.
Event producers, routes and scheduler wiring remain BILL-19; email delivery
remains BILL-18. Do not deliver to live email recipients before BILL-18.

### BILL-18 — Email delivery and seven-day reminders

Status: delivery adapters, versioned templates and event-handler contracts implemented. BILL-19 must wire these handlers and schedule the delivery worker and renewal scanner. SMTP was not contacted and no migration was applied.

Dependencies: BILL-04, BILL-09, BILL-11, BILL-15, BILL-17. Own:
adapters/delivery/, notification templates and reminder consumer.

Implement SMTP adapter result states, stable delivery IDs, retries/dead-letter,
in-app notifications and one reminder per period seven days before exact expiry.
Late scans catch up while active; next-cycle paid suppresses reminder; pending
verification has distinct messaging. Payment decisions send accurate confirmation.
Use one versioned central email-template registry for all product email, including
the existing account-creation welcome template and currently inline templates;
preserve existing template exports as compatibility wrappers during migration.

Acceptance: missing SMTP is visible as skipped/unconfigured; failed delivery cannot
repeat funding; paid/cancelled renewals are handled; reminder uses actual dates and
renewal quote; live recipient emails are not used during verification.

### BILL-19 — HTTP APIs, permissions and composition

Dependencies: BILL-05 through BILL-18. Own: adapters/http/, composition.js,
authorization integration, route registration, scheduler definitions and read DTOs.

Wire completed modules, shared financial UnitOfWork and worker handlers. Implement
architecture API surfaces, granular permissions, idempotency/version headers,
scoped read projections and persistent notifications. Add due-job scheduler triggers
and per-org feature flags. Retire competing policy writes only for migrated orgs.

Acceptance: route tests verify cross-org/workspace denial and platform-only approval;
read permissions cannot write; frontend scope headers distinguish organization
resources; no fake handlers; registered jobs are safe across process replicas.

## Wave E: frontend tasks

### BILL-20 — Shared typed billing client and UI contracts

Dependencies: BILL-01; finalize against BILL-19. Own frontend:
src/lib/billing/, billing DTO/decimal format helpers and shared UI primitives.

Implement client contracts, versioned mutations/idempotency keys, cursor reads,
amount formatting and consistent financial error rendering. Publish interfaces
before parallel UI tasks. Fixtures may support local development only.

Acceptance: no financial Number arithmetic; mutation retries reuse request key;
conflicts prompt refresh; no production mock fallback; apiFetch integration patch
is supplied to integration owner.

### BILL-21 — Platform plan/subscription/entitlement screens

Dependencies: BILL-05, BILL-06, BILL-19, BILL-20. Own frontend:
src/admin/billing/plan*, subscription*, entitlement* components.

Implement versioned plan catalog, purchased org terms, quote preview, effective
dates, workspace/industry entitlements and downgrade conflict display.

Acceptance: purchased terms remain identifiable; immediate changes show reviewed
impact; org admins cannot reach platform controls. Provide OrgDetailPanel and
CreateWorkspacePage integration patches.

### BILL-22 — Platform payment review and invoice screens

Dependencies: BILL-09, BILL-15, BILL-19, BILL-20. Own frontend:
src/admin/billing/payment*, invoice*, adjustment* components.

Implement queue, private receipt review, dates/amount/credit approval preview,
reject/clarification, history, invoice payments and privileged adjustment reasons.

Acceptance: approval cannot be repeated accidentally; pending/scheduled/active
funding is clear; amount mismatch cannot be ignored; error states refresh versions.

### BILL-23 — Organization subscription, payments and contacts UI

Dependencies: BILL-08, BILL-17, BILL-19, BILL-20. Own frontend:
src/features/billing/subscription/, payments/, contacts/.

Implement subscription dates/renewal quote, payment submission/proof, verification
history, invoices, billing contacts and permitted alert settings.

Acceptance: actual cycle dates displayed; pending payment never appears paid;
receipt ownership enforced server-side; invoice payment and top-up are distinct.

### BILL-24 — Admin pool, allocation and postpaid UI

Dependencies: BILL-10, BILL-14, BILL-19, BILL-20. Own frontend:
src/features/billing/allocations/, postpaid/.

Implement separate credit pools, workspace allocation matrix, previews/transfers,
fixed/percentage rules, run states and explicit workspace postpaid permissions.

Acceptance: remaining/admin/held balances distinguish ownership; rule edits explain
future effect; unlimited confirmation shows surviving org/overall caps; invalid
previews cannot be submitted.

### BILL-25 — Workspace billing and durable notification UI

Dependencies: BILL-17, BILL-18, BILL-19, BILL-20. Own frontend:
src/features/billing/workspace/, src/features/notifications/.

Implement workspace credit expiry, top-up balance, holds, usage/caps, postpaid debt,
typed blocking messages and persistent bell/read state. Supply App/NotificationBell
integration patches preserving live call notifications.

Acceptance: reload retains financial notifications; workspace switch does not leak
balances; organization financial notifications remain accessible to org admins.

### BILL-26 — Frontend integration and existing-flow replacement

Dependencies: BILL-21 through BILL-25 plus BILL-16, BILL-19. Own shared frontend:
App.tsx, admin navigation, existing settings/org/workspace pages, apiFetch policy,
authorization mapping and DialerSimulator funding gate.

Wire new screens and feature flags; replace direct recharge and old wallet checks
for migrated orgs. Retain legacy paths only for explicit legacy ownership.

Acceptance: production build passes; role navigation and all new APIs align;
no old client gate blocks a funded workspace; direct unreviewed funding is absent
for migrated organizations; empty/error/loading states are complete.

## Wave F: reconciliation, migration and release

### BILL-27 — Reconciliation and operational controls

Dependencies: BILL-11, BILL-15, BILL-16, BILL-18, BILL-19. Own:
reconciliation services, metrics, diagnostic/repair CLI and operations docs.

Implement grant conservation, journal balance, positions/holds, debt/invoices,
unapplied usage and outbox checks. Add dry-run repairs, audited operation IDs,
processing dashboards and per-org pause controls. Measure lock and funding latency.

Acceptance: intentionally introduced drift is detected; repair is idempotent;
metrics distinguish financial failure from delivery failure; no repair silently
rewrites historical journals.

### BILL-28 — Legacy migration and cutover tooling

Dependencies: BILL-16, BILL-19, BILL-27. Own: migration CLI, legacy adapters and
cutover runbook; integration owner applies archive/deletion protection.

Implement legacy/shadow/ready/enforced state, opening grant and debt review,
original reservation engine ownership, policy/date import and cutover reports.
Brief org write fence is preferred over uncontrolled dual writes.

Acceptance: reserved balance is not added twice; shadow never debits or emails;
historical estimates do not become invented debt; active holds settle once;
PAYG workspaces require explicit configuration; rerun does not duplicate imports.

### BILL-29 — Financial integration and load acceptance

Dependencies: BILL-26, BILL-27, BILL-28. Own: meaningful end-to-end financial
verification, representative load scenarios and acceptance report.

Exercise approval -> grant -> allocation -> usage -> expiry/renewal; top-up
fallback; workspace postpaid -> invoice -> payment; late costs; job crashes;
cross-org denial; mode changes and migration under active calls.

Acceptance: real-DB concurrency and multi-worker recovery pass; latency/lag targets
are agreed and measured; unsupported paths and remaining risks are explicit.
Do not enable enforcement when financial invariants or migration totals fail.

### BILL-30 — Coordinated deployment and staged enablement

Dependencies: BILL-29. Own: release integration, deployment commands and rollout
record. Requires coordinating user's release authorization.

Deploy backward-compatible backend/migrations before dependent frontend. Include
exact VM backup/migrate/application-services command, worker configuration and log
commands. Verify SMTP configuration without sending unsolicited customer emails.
Enable selected development orgs, reconcile, then expand by organization.

Acceptance: recorded deployed commits, migration status, worker/job health,
Vercel status and opening balances; operational pause procedure available;
rollback cannot reactivate legacy debits for already migrated funds.

## Reusable agent assignment prompt

Copy the block below and replace TASK_ID with one task above:

```text
Implement TASK_ID from:
/Users/sanjay/Documents/chiefxai/crm-backend-test/docs/billing-implementation-tasks.md

Read that task, its completed dependency handoffs, the assignment rules and:
/Users/sanjay/Documents/chiefxai/crm-backend-test/docs/billing-credits-architecture.md

Backend: /Users/sanjay/Documents/chiefxai/crm-backend-test
Frontend: /Users/sanjay/Documents/chiefxai/com-frontend-test

Work only within this task's ownership. Follow repository instructions. Inspect
current code before editing. Preserve other agents' work. Shared-file changes go
in your handoff for the integration owner. If a required dependency is missing,
report precisely what contract is needed; do not wire a production placeholder.

Deliver code and meaningful checks appropriate to financial risk. Keep customer
delivery and new billing enforcement disabled. Do not deploy, send real messages,
apply production migrations or push shared main. Do not spawn additional agents.

Finish with: files changed; public interfaces/event schemas; checks and results;
known limitations; shared-file integration patch; next dependent task IDs.
```

## Suggested first assignment

Start with BILL-01. Review its exported contracts before BILL-02. After BILL-02,
BILL-03 and BILL-04 can proceed independently within their file ownership.
Use small task handoffs as the context for the next agent; the architecture and
this backlog stay the shared reference throughout implementation.
