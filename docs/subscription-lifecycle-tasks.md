# Subscription purchase, renewal, upgrade and grace tasks

Created 11 October 2026 from the organization subscription investigation and agreed feature scope. Implementation is in progress. Checked tasks do not imply release approval. No migration or feature flag was enabled.

Backend: `crm-backend-test`. Frontend: `com-frontend-test`.
This focused backlog supplements BILL-05/06/09/11/19/21/22/23/26 and the release/integration work in [billing-implementation-tasks.md](billing-implementation-tasks.md). Reuse existing billing components; do not implement another ledger or payment approval system.

## Requested behavior

- Organization creation must provide the initial subscription purchase process based on the selected plan.
- Paid subscription activation issues the plan's included credits to the organization pool.
- Organizations can renew and request a higher plan.
- Renewal becomes available seven days before the paid period ends and remains available while overdue.
- An unpaid organization loses operational access when its deadline passes.
- An organization can request more time; platform administrators can decide and audit the extension.
- Billing recovery remains accessible while operational access is suspended.

## Policy decisions to settle in SUB-01

These are proposed defaults, not previously approved payment rules:

| Decision | Proposed default |
| --- | --- |
| Suspension deadline | Proposed default: seven days after period expiry (14 days after the D-7 renewal notice). Keep configurable and confirm the commercial policy before enabling enforcement. |
| Initial unpaid organization | Billing-only access until the first payment is approved; an explicit trial requires its own policy. |
| Payment submitted but not reviewed | Submission is not payment confirmation. Decide whether a bounded review hold applies; otherwise the ordinary deadline applies. |
| Grace request pending | No extension until a platform administrator approves it. |
| Grace amount and repeated requests | Platform-configured maximum duration; define cumulative limits, revocation and repeat-request rules. |
| Credits during grace | No new subscription credits and no automatic extension of expired grants. Define which existing top-up/postpaid funding can support usage. |
| Immediate upgrade | Approved prorated difference for remaining service and incremental included credits; preserve the current renewal anchor. Also offer a next-period change if required. |
| Downgrade | Apply at renewal, with explicit workspace/seat/feature conflict resolution. |
| Late payment | Define whether renewal resumes the original anchor during approved grace or starts a fresh cycle after suspension. |
| Payment method | Start with existing manual receipt review; platform payment instructions must be configured. A payment gateway is a separate integration. |
| Currency, tax and discounts | INR initially; specify rounding, invoice numbering, taxes, discounts and refund rules before charging customers. |

## Current source facts

- `src/routes/platform.js` selects a workspace plan and saves a plan policy snapshot.
- `src/db/repositories/organizationRepository.js:createOrganizationSetup` creates the organization and billing account, but no initial subscription quote, payment or funded period.
- `monthlySubscriptionCreditsInr` in platform workspace plans drives the entitlement display; paid-period activation reads `termsSnapshot.terms.includedCredits`. A deliberate mapping is required between these paths.
- `src/billing/modules/payments/decisions.js` already schedules a funded subscription period after subscription payment approval.
- `src/billing/modules/subscriptions/periodActivationService.js` issues a subscription grant when an approved funded period activates.
- The organization billing UI submits top-ups and workspace add-on payments. Initial subscription and renewal quote/payment screens are missing.
- The renewal scanner and activation entrypoint exist as gated one-shot operations. The repository has no automatic subscription lifecycle scheduling configured.
- `src/middleware/auth.js` rejects manually suspended organizations before billing recovery can run. Billing suspension must be distinguishable from other platform suspensions.
- Workspace add-on renewal and expiry already exist separately. Organization subscription renewal must not replace or double-charge those cycles.

## Task inventory and dependencies

| Task | Work | Depends on |
| --- | --- | --- |
| SUB-01 | Billing policy and shared contracts | None |
| SUB-02 | Canonical plan versions and quote composition | SUB-01 |
| SUB-03 | Subscription and grace persistence | SUB-01, SUB-02 |
| SUB-04 | Initial organization purchase | SUB-02, SUB-03 |
| SUB-05 | Renewal APIs and approved payment fulfillment | SUB-02, SUB-03 |
| SUB-06 | Plan upgrades and scheduled downgrades | SUB-02, SUB-03, SUB-05 |
| SUB-07 | Grace request and decision APIs | SUB-03, SUB-05 |
| SUB-08 | Access enforcement and billing recovery | SUB-03, SUB-04, SUB-05, SUB-07 |
| SUB-09 | Organization subscription UI | SUB-04, SUB-05, SUB-06, SUB-07, SUB-08 |
| SUB-10 | Platform subscription and grace UI | SUB-04, SUB-06, SUB-07, SUB-08 |
| SUB-11 | Lifecycle scheduling and durable delivery | SUB-04, SUB-05, SUB-06, SUB-07, SUB-08 |
| SUB-12 | Existing-organization reconciliation | SUB-02, SUB-03, SUB-04, SUB-08 |
| SUB-13 | Integrated validation and failure recovery | SUB-04 through SUB-12 |
| SUB-14 | Controlled release and operations | SUB-13 |

### [x] SUB-01 — Decide billing policy and publish contracts

Deliver a confirmed policy covering every proposed default above. Define purchase, renewal, upgrade, grace and suspension commands, response types, permissions and events. Define the period states separately from payment states and organization operational access. Use exact decimal-string monetary units, an injectable clock and server-assigned actor/organization scope.

Acceptance: examples cover first purchase, early/late renewal, pending review, grace approval, upgrade and billing-only suspension. Specify calendar anniversary/timezone behavior including month-end dates. Document the initial fee and included-credit amount independently. No implementation invents its own deadline or upgrade arithmetic.

Implementation: see [subscription-policy-contract.md](subscription-policy-contract.md), injectable defaults in `src/billing/modules/subscriptions/policy.js`, and v1 contracts in `src/billing/contracts/subscription.js`. These are proposed configurable defaults pending business-owner review; release flags remain off.

### [ ] SUB-02 — Connect platform plans to versioned financial quotes

Primary backend areas: `src/platform/billingSettings.js`, `src/workspaces/organizationPolicy.js`, `src/billing/modules/catalog/`, new subscription HTTP composition.

Create a canonical, versioned mapping from the selected platform plan to purchased billing terms. Add organization-scoped initial purchase, renewal and upgrade quote creation/read/acceptance. Compute charges from validated plan terms and inventory. Include seats/workspaces/industry charges only according to the policy; exclude already separately invoiced add-ons. Snapshot included credits, currency/scale, tax, effective dates and expiry. Wire routes into `src/routes/billing.js`.

Acceptance: displayed allowance matches the purchased quote's included credits; changing a plan cannot change a paid quote or active purchased terms. Reject stale plan versions, expired quotes and cross-organization references. Multiple clicks reuse an idempotent quote. Demonstrate an Enterprise quote with ₹4,000 included credits without treating ₹4,000 as the subscription fee.

Progress: initial purchase and renewal quotes use canonical published plan versions and immutable snapshots; expired quotes can be reissued with a fresh idempotency key. Upgrade quoting and integrated financial/MySQL acceptance remain open.

### [ ] SUB-03 — Add subscription access and grace persistence

Primary backend areas: additive `src/db/migrations/`, subscription/grace repositories and contracts.

Persist an organization subscription association, period/plan-change linkage and subscription access policy. Add grace requests and immutable decisions tied to the expiring period, including requested deadline, justification, approver, decision reason, granted deadline, revocation and version. Track billing suspension cause independently from manual/security suspension. Reuse existing quotes, payments, periods, grants, journal, outbox and command idempotency tables.

Acceptance: migration IDs are selected from the current registry; historical checksums remain unchanged. Organization ownership and unique/idempotency constraints prevent duplicate initial purchases, overlapping funded periods and competing effective grace decisions. Financial and grace history survives reconciliation. Data model supports a billing-only access response.

Progress: additive subscription/access/period/grace tables and repositories are implemented and registered. Read-only candidate reconciliation exists; approved historical data migration remains open.

### [ ] SUB-04 — Create and activate the first subscription purchase

Primary backend areas: `src/routes/platform.js`, `src/db/repositories/organizationRepository.js`, billing purchase composition and existing payment/period modules.

Extend organization setup to provision the initial quote and explicit subscription onboarding status using server-resolved plan terms. Persist a recoverable setup workflow if quote creation cannot share the existing transaction. Offer the first payment through the existing proof submission API. Route approved payments into funded-period creation and due activation. Grant credits once to the organization pool. Apply the initial access policy from SUB-01.

Acceptance: creation shows a payable initial subscription and configured allowance. Unpaid/denied requests issue no credits. Approved first purchase establishes actual billing dates and issues the exact purchased credits once. Organization/auth provisioning retries cannot duplicate a purchase or grant; partial setup failures are visible and recoverable.

Progress: organization setup provisions an immutable initial quote when explicitly enabled; payment approval links the funded period; activation issues the snapshotted grant and persists an access deadline. Database migration and live MySQL verification remain open.

### [ ] SUB-05 — Implement renewal purchase and approval

Primary backend areas: subscription quote APIs, `paymentSubmissionRouter.js`, `modules/payments/decisions.js`, subscription lifecycle/repositories.

Expose renewal eligibility and the server-calculated payable quote from seven days before expiry, including overdue organizations. Reuse receipt validation, exact received amount verification, platform approval and payment history. Approved early renewal funds the period beginning at the existing end. Apply the late-renewal and review-hold policies. Return pending, needs-information, rejected, scheduled and active states clearly.

Acceptance: paying for a top-up cannot renew a subscription. Payment submission does not mark a subscription paid. Approval is idempotent and schedules one non-overlapping next period. Before its start, future credits remain unavailable; due activation issues them once. Duplicate references and approval-versus-suspension races resolve safely.

Progress: renewal eligibility, quote/link creation, and existing payment proof/approval flow are implemented behind the purchase flag. Full overlap and approval/suspension race testing remains open.

### [ ] SUB-06 — Implement higher-plan changes and downgrade handling

Primary backend areas: catalog adjustment quote, subscription lifecycle and effective entitlements.

Offer available target plans with an impact preview. Implement the confirmed immediate/next-period upgrade rules with exact proration based on the remaining interval. On approval, apply the new effective entitlements and incremental credits according to policy while preserving history and avoiding duplicate full-month grants. Support next-period downgrade scheduling only when inventory conflicts are resolved. Invalidate or reconcile competing renewal/upgrade quotes.

Acceptance: a user cannot activate the higher plan by editing a plan name. Approved upgrade amount and additional credits match the quote; existing consumed/reserved amounts remain valid. Renewal uses the correct post-upgrade plan. Failed or repeated approvals cannot partly apply the plan. A downgrade never silently deletes workspaces or users.

Progress: immediate adjustment quotes provide a read-only price/credit preview and the platform payment review read model exposes a normalized `subscriptionUpgrade` DTO. Adjustment quotes remain rejected by payment submission and direct approval is rejected before quote/payment mutation; no environment flag can enable partial fulfillment. The existing `organization_billing_terms` repository is versioned but has no live workspace/member entitlement consumers, so writing there alone would not apply entitlements. Target inventory fit, effective-term history integration, atomic approval and incremental credits, scheduled downgrades, organization UI, staging, and release evidence remain open. SUB-06 is not complete.

### [ ] SUB-07 — Implement grace requests and platform decisions

Primary backend areas: new billing grace module, organization billing routes, platform billing routes and audit log.

Allow authorized org billing administrators to request more time with a reason and requested deadline. Expose a platform queue and approve/deny/revoke commands. Enforce maximum/cumulative extension rules and expected versions. Publish durable requested/approved/denied/revoked events. An approved extension controls operational access without creating a paid period or credits.

Acceptance: requests and pending decisions confer no unapproved extension. Only authorized platform operators can decide. Concurrent decisions cannot create inconsistent deadlines. Extensions target the correct period and remain auditable. Approved grace can restore access blocked solely by billing, but cannot clear manual/security suspension.

Progress: organization request and platform decision APIs plus queue UI exist behind a separate flag. Grace request/approval/denial notifications are emitted through the opt-in outbox. Revocation notification and full concurrency testing remain open.

### [ ] SUB-08 — Enforce subscription access with a recovery path

Primary backend areas: `src/middleware/auth.js`, `src/authorization/`, workspace repositories, telephony/usage entry points, queue consumers and frontend routing.

Compute one subscription access decision using purchased period dates and effective approved grace/review hold. Enforce it for CRM reads/writes, call initiation, campaign workers and other operational integrations. Keep validated membership, identity, subscription billing, receipt submission, grace request/status and logout available through an explicit recovery permission set. Do not grant ordinary CRM permissions through the recovery context. Preserve independent manual/security suspension rules. Define handling for calls already in progress at expiry.

Acceptance: expiry is enforced on requests/workers even if a lifecycle tick is late. Org admins can pay after billing suspension. Other members get a clear restricted-access state. Direct APIs, child workspaces, queued calls and long-lived connections cannot bypass billing enforcement. Payment approval cannot reactivate an unrelated manual suspension.

Progress: authenticated HTTP requests check access state and persisted deadline; billing recovery remains reachable. A scheduled expiry worker is registered. Internal-token APIs, workers, telephony/WebSocket tickets, and in-progress calls still need separate coverage.

### [ ] SUB-09 — Build organization subscription and recovery UI

Primary frontend areas: feature billing components, `components/billing/BillingWorkspace.tsx`, `lib/billing/`, membership/access routing.

Provide current plan, actual paid dates, payable amount, included credits, issued credits and deadline. Add initial purchase, Renew subscription, Upgrade plan and Request grace actions. Show payment instructions, immutable quote review, proof upload, pending/rejected/clarification states and history. Keep renewal available after the seven-day window until settled. Render a billing recovery screen for restricted organizations. Display dates in the user's timezone with a clear exact deadline.

Acceptance: server state drives action availability; client clock cannot authorize payment/extension. No duplicate submission on retry. Show grace status and approved deadline. Distinguish fee payment, credit top-up and add-on invoice. Workspace switching cannot expose another organization's quote, receipt, payment or grace request.

Progress: initial purchase, renewal, grace, and non-payable upgrade-preview UI are integrated into Billing → Subscription. Upgrade payment/apply and a dedicated recovery screen remain open.

### [ ] SUB-10 — Build platform subscription and grace controls

Primary frontend areas: `admin/PaymentReviewsPage.tsx`, `admin/OrgDetailPanel.tsx`, subscription/grace admin components and routes.

Extend existing payment review to show initial/renewal/upgrade purpose, dates, plan changes and credits before approval. Add grace queue, configured limits, approve/deny/revoke actions and audited history. Show billing suspension independently from manual suspension. Provide reconciliation/retry tools for incomplete activation rather than direct edits to balances or paid flags.

Acceptance: receipt and exact amount must be reviewed before approval. Operators see whether a period is pending, scheduled or active. Plan/grace changes use server permissions and expected versions. Clearly identify the access deadline and why an org is restricted. Every privileged change records an actor and reason.

Progress: financial terms editor and grace queue/decisions are implemented. Payment review can display a normalized upgrade quote DTO if linked, but upgrade payments remain disabled; reconciliation remains read-only with no write/retry controls.

### [ ] SUB-11 — Schedule lifecycle jobs and deliver notifications

Primary backend areas: `src/billing/lifecycleJobComposition.js`, notification outbox/email composition, scheduler definitions/runner, deployment templates and worker entrypoints.

Wire supervised recurring scans for upcoming renewal, due funded-period activation, expired subscription/grace enforcement and reconciliation. Use the existing scoped outbox and email workers; register all required consumers before enabling their event types. Generate in-app and verified-contact notifications for renewal due, proof received, clarification, approval, grace decisions, imminent suspension, suspension and reactivation. Add startup recovery scans, retries, leases, idempotency, lag metrics and health checks.

Acceptance: reminders are generated from actual paid-period ends, default seven days ahead. Repeated/restarted jobs do not duplicate grants or decisions. Already-funded renewal suppresses unpaid notices. Failure to deliver email does not alter financial state. An approved request appears in the platform queue without relying on receipt of an email. Feature enablement and scheduler configuration are explicit.

Progress: activation, renewal reminder, and access enforcement schedules are registered behind default-off flags. Access restriction and grace request/decision notifications are handled by the opt-in outbox. Email delivery scheduling/deployment, revocation/restoration notifications, reconciliation recovery, metrics, and health checks remain open.

### [ ] SUB-12 — Reconcile existing organizations safely

Primary backend areas: new bounded audit/migration scripts and runbook.

Inventory organizations with plan snapshots but no subscription periods, legacy balances, active add-ons, inconsistent quote terms or missing grants. Produce a read-only preview with proposed classifications. Define approved migration or grandfathering actions and explicit enforcement eligibility. Preserve all existing ledgers and records; never infer payment from a plan name or copy a legacy recharge balance into a subscription grant.

Acceptance: existing users are not suspended merely because their pre-feature billing records are absent. Each migrated org has identifiable approved terms, provenance, access deadline and correct opening ledger. Repeated reconciliation is idempotent. Unresolved orgs are reported for operator review and excluded from new automatic enforcement until resolved.

Progress: read-only candidate preview is available to platform operators at `/api/platform/billing/subscription-reconciliation/preview`, with bounded pagination and evidence classifications. It never infers payment, period, price, or credits. Any approved migration/write path remains open.

### [ ] SUB-13 — Validate complete behavior and failure recovery

Deliver focused unit/API/UI verification plus real MySQL integration coverage for financial and concurrency claims. Repair or isolate existing runner/mocking problems that prevent these checks from giving a reliable result.

Required scenarios: initial unpaid/approved purchase; D-7 renewal; early and late approval; pending-review policy; no payment at deadline; grace requested/approved/denied/revoked/expired; paying while suspended; manual suspension preservation; immediate upgrade and renewal collision; duplicate proof/approval/job tick; month-end/timezone boundaries; expired quote; stale plan version; migration retries; outbox/SMTP outage; failed activation; tenant/role isolation; in-progress call handling.

Acceptance: no double funding, duplicate grant, overlapping period or unsupported financial mutation. Backend failures surface in UI/operations reports. Frontend build/type checks and targeted regression checks pass; known unrelated baseline failures are explicitly recorded. No real customer payment, call or email is used for test verification.

Progress: focused backend/frontend suites and frontend build pass. The full backend suite has unrelated baseline failures and sandbox listener restrictions; MySQL integration and broad recovery scenarios remain open.

### [ ] SUB-14 — Release and operate the feature

Deliver migration procedure, rollback/disable procedure, scheduling/worker deployment configuration, flags, initial tenant selection and operator playbook. Roll out purchase/renewal flows first, then validate lifecycle/delivery, then enable expiry enforcement for reconciled tenants. Define dashboards for pending reviews, upcoming expiry, job lag, activation failures, notification dead letters and active grace extensions.

Acceptance: staging has completed SUB-13; production payment instructions and billing recipients are configured. Enablement identifies who can approve payments and grace. Financial history remains valid when enforcement is disabled. Production migration, external delivery and enablement are separate authorized release actions.

Progress: initial operations/runbook guidance is in [billing-subscription-lifecycle-operations.md](billing-subscription-lifecycle-operations.md). Deployment templates, dashboards, health/lag alerts, and actual staging validation remain open.

## Work order

1. Policy and data contracts: SUB-01 → SUB-02 → SUB-03.
2. Core backend behavior: SUB-04 → SUB-05 → SUB-06 → SUB-07 → SUB-08.
3. Product and operations: SUB-09 → SUB-10 → SUB-11 → SUB-12.
4. Validation and release: SUB-13 → SUB-14.

Implementation can be split further after SUB-01 publishes contracts. Shared composition, migrations, authorization and scheduler files should be integrated in dependency order. Status updates should mark only work actually completed and validated.
