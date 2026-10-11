# Provider-independent telephony connector tasks

Status: in progress. Provider metadata, additive persistence, scoped account APIs, initial inventory management, explicit number verification, Platform Admin UI, organization-owned account/inventory UI, transactional number reservation during organization creation, workspace-scoped caller ID selection, safe assigned-number resolution, route-bound Vobiz outbound calls and webhook authentication, auto-dial and scheduled-redial resolution, restart context recovery, duplicate fallback suppression and per-call ownership snapshots are implemented. Inbound connector routing, provider validation, migration of existing Vobiz data, broader reporting alignment and staging validation remain pending.

## Current implementation slice

- [x] Add optional provider credential-schema and capability metadata to the existing adapter registry; keep current adapters compatible.
- [x] Add an additive generic migration for connector accounts, number inventory and assignment history, supporting many accounts per provider.
- [x] Add nullable call-log attribution fields for provider, account, number, assignment and ownership; legacy call rows remain valid.
- [x] Add durable call-route and provider-call-alias tables with constrained lifecycle status transitions.
- [x] Add focused tests for provider definitions and schema invariants.
- [x] Add default-off, ownership-scoped connector account CRUD and inventory service foundations.
- [x] Add transactional number assignment/release history without modifying current virtual-number or provider-call behavior.
- [x] Require connector owners to explicitly verify an existing number before assignment or routing; verification is an administrator attestation, not provider API validation.
- [x] Add default-off platform and organization account/inventory APIs with owner-scoped assignments.
- [x] Add Platform Admin account and inventory UI with schema-driven credentials and explicit non-routable assignment messaging.
- [x] Offer optional platform number reservation in organization creation while preserving customer-owned Vobiz credential setup.
- [x] Show assigned, ready Vobiz numbers in the dialer caller ID selector; keep unsupported provider numbers out of the current Vobiz call path.
- [x] Reserve the selected number in the organization-creation transaction and roll back organization creation if the number cannot be claimed.
- [x] Add a separate organization settings panel for multiple customer-owned provider accounts and per-account number inventory; retain the existing Vobiz calling setup.
- [x] Keep new account and inventory APIs default-off; no existing provider path reads the new records.
- [ ] Enable the account feature flag only after staging authorization and migration checks are complete.
- [x] Preserve the existing Vobiz path by default while adding account-aware routing behind two opt-in flags; focused compatibility checks pass.

Implemented API gate: `TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED` (default off). Connector-backed Vobiz outbound routing also requires `TELEPHONY_CONNECTOR_CALL_ROUTING_ENABLED` (default off).

The migration deliberately does not reinterpret existing `channels` or `virtual_numbers` rows. Existing Vobiz data ownership remains unresolved until the separately planned dry-run/reconciliation and migration work.

## Scope and acceptance requirements

- Platform admins and organization admins can each configure multiple accounts for the same provider.
- Platform-owned accounts supply numbers to customers without copying credentials into each organization.
- Organization-owned accounts remain private to their organization. Preserve the current own-Vobiz credential-entry workflow while extending it to multiple accounts.
- Provider integrations are adapters; configured connector accounts are database records. Do not confuse these concepts.
- Adding Twilio or another provider requires an adapter, credential schema, registration and integration tests, without changes to shared account management, allocation, permissions or billing orchestration.
- Vobiz is the first production adapter. Actual Twilio integration and automatic number purchasing are separate work, not included in this implementation.

## T01 — Define provider and account contracts

- [x] Extend `src/telephony/base.js` and `src/telephony/registry.js` with optional credential schemas and account-management capabilities.
- [ ] Define adapter operations for validation, number discovery/verification, inbound provisioning, outbound calls, hangup, webhook verification and event normalization.
- [ ] Define normalized number, call, event and error formats, including provider account IDs, provider number IDs and provider call IDs.
- [ ] Make optional operations capability-driven. Separate PSTN account capabilities from other integrations already registered, such as Gemini.
- [ ] Keep provider-specific HTTP and media protocols inside adapters; shared code uses exact registered provider keys.

Depends on: none.
Acceptance: adapter contract supports different credential fields, account hierarchies and webhook formats without provider-specific branches in shared services.

## T02 — Add connector account and allocation persistence

- [x] Add additive migration for connector accounts, phone-number inventory and assignment history.
- [ ] Accounts store provider key, display name, owner type, optional owner organization, provider account identity, encrypted credentials, credential version and status.
- [ ] Numbers reference their connector account, provider number identity, normalized number and provisioning status.
- [ ] Assignments reference number, organization, workspace, actor and assigned/released timestamps.
- [ ] Link existing `virtual_numbers` to inventory while retaining existing routing and agent configuration.
- [ ] Enforce one active assignment per number transactionally; prevent conflicting registration of the same provider account and number. Allow many distinct accounts for one provider.
- [ ] Enforce owner organization consistency and workspace membership; preserve historical references when records are retired.

Depends on: T01.
Acceptance: four accounts for one provider can each hold ten numbers; concurrent allocation cannot assign the same number twice.

## T03 — Implement connector account service and secure APIs

- [x] Add scoped services and APIs for create, list, update, rotate and disable account operations.
- [ ] Reuse the existing credential encryption mechanism; credentials are encrypted once per account and never returned in plaintext.
- [ ] Add platform-admin APIs and organization-admin APIs with explicit ownership authorization.
- [ ] Generate safe API responses from credential schemas; redact secrets in logs, errors and audit metadata.
- [ ] Track validation status and credential version. Treat rotation as an explicit operation, preserving provider-specific handling needed for callbacks and live calls.
- [ ] Audit account creation, rotation, disable and ownership changes.

Depends on: T01, T02.
Acceptance: one organization cannot inspect or operate another organization's account; platform secrets are absent from organization responses.

## T04 — Implement inventory, assignment and provisioning services

- [ ] Discover numbers when supported; otherwise register manually and verify account membership through supported provider mechanisms.
- [ ] Add inventory filtering by provider, connector, availability, organization and workspace.
- [x] Allocate and release inventory transactionally with assignment history. Integration with `virtual_numbers` is still pending.
- [ ] Allow platform accounts to supply multiple customers; constrain organization-owned accounts to their owner organization.
- [ ] Add idempotent provisioning jobs with pending, ready and failed states, retries and explicit retry actions.
- [ ] Reject reassignment while calls are active; retain history for delayed events. Release does not purchase, delete or cancel provider numbers.
- [ ] Account disabling blocks new work; deletion is refused while active references remain, with retirement supported instead.

Depends on: T02, T03.
Acceptance: assigning a number makes routing status visible; failed provisioning can be retried without duplicate allocation.

## T05 — Add shared credential resolution and telephony orchestration

- [x] Resolve an explicitly selected number's active assignment and connector account, scoped to the exact organization/workspace; require active account and ready inventory before returning internal credentials.
- [x] Add optional connector attribution to finalized call-log records when the call context supplies it.
- [x] Add durable call-route creation, provider call ID aliasing, and safe route lookup primitives; reject stale assignments and conflicting provider call IDs.
- [x] Snapshot connector ownership and charge scope on outbound billing reservations; provider cost estimates and settlement use saved connector context while legacy reservations keep legacy classification.
- [x] Route an explicitly selected ready Vobiz assignment through its connector account behind separate default-off account and call-routing flags.
- [x] Authenticate route-bound Vobiz callbacks with that account's signature key and a per-route secret token, persist provider call aliases/state and billing linkage, and resolve hangup credentials from the durable route.
- [x] Route explicitly selected Vobiz calls using account, number, organization and workspace context; hangup resolves the durable route and its connector credentials.
- [x] Persist connector ID, provider call ID aliases, number and assignment references before callbacks; call-start idempotency remains pending.
- [x] Re-resolve the exact number assignment and credential version before scheduled redials; fail closed if either changed.
- [x] Rehydrate route ownership, billing reservation and call-log attribution when callbacks arrive after a process restart.
- [x] Persist bounded, non-secret task, campaign, question and retry context with each route for restart recovery.
- [x] Suppress duplicate synthetic call-log creation from concurrent route-bound Hangup callbacks.
- [x] Verify route-bound Vobiz callback signatures with the assigned connector account before tenant routing; inbound candidate selection for future providers remains pending.
- [ ] Deduplicate webhook events and retain historical call routing after number release or reassignment.
- [ ] Continue necessary callbacks and hangups for active calls when a connector is disabled, while blocking new calls.

Depends on: T01–T04.
Acceptance: an organization with several accounts always calls through the selected number's account; unauthorized numbers and ambiguous account resolution fail safely.

Explicitly selected, ready Vobiz assignments can use their connector credentials for outbound calls when both flags are enabled. This includes manual calls, background auto-dial and scheduled retries. The call route is persisted before the provider request, and callbacks carry a route ID plus per-route token for account-specific signature verification and hangup credential lookup. Route context and billing linkage can be recovered after a process restart. Inbound connector routing, generic webhook event deduplication and retained credential versions for delayed callbacks remain pending. Credential rotation increments the credential version when values change and refuses rotation while a durable call route is active; public responses omit ciphertext and plaintext.

Organization deletion cleanup explicitly releases platform-owned numbers and removes organization-owned connector inventory before deleting the organization, avoiding foreign-key failures and stranded inventory.

## T06 — Adapt Vobiz and existing calling paths

- [x] Extend `src/telephony/connectors/vobiz.js` with the account-aware outbound contract.
- [x] Resolve assigned connector credentials for outbound calls, hangup and scheduled redials while retaining the legacy channel path.
- [x] Carry account/number context through manual calls, background auto-dial, retries and post-call processing.
- [ ] Preserve Vobiz media authorization and workspace scope while moving shared orchestration out of provider handlers.
- [ ] Keep existing endpoints compatible through the shared service; defaults must resolve a valid assigned number explicitly.
- [ ] Stop using channel existence to represent ownership; leave messaging-channel behavior unchanged.

Depends on: T05.
Acceptance: existing Vobiz inbound/outbound workflows function with both platform-owned and organization-owned accounts and multiple accounts per organization.

## T07 — Correct ownership-aware billing and reporting

- [ ] Replace Vobiz-channel-based self-managed classification in billing and platform cost reporting.
- [x] Snapshot connector ownership on each recharge reservation; provider and charging policy remain separately recorded as before.
- [x] Apply provider-cost treatment by per-call owner for platform and customer-owned accounts.
- [ ] Align billing summaries and frontend cost displays; do not recompute historical ownership from current account settings.
- [ ] Block new billable calls when ownership or charging policy is unresolved; preserve historical charges.

Depends on: T05, T06.
Acceptance: the same organization can use platform and own accounts without missing or duplicating provider charges; later reassignment cannot change historical billing.

## T08 — Build Platform Admin connector management

- [x] Add Telephony / Connectors navigation to `src/admin/AdminShell.tsx` in the frontend repository.
- [x] Build generic provider selection and credential forms from registry metadata with masked credential updates. Provider validation results depend on future adapter support.
- [ ] List account names, provider, status and total/available/assigned number counts.
- [x] Add connector details with manual inventory registration, assignment, release and disable actions. Discovery and provisioning retry depend on future adapter/job support.
- [ ] Support multiple accounts for each provider and clear account identification throughout the UI.

Depends on: T03, T04.
Acceptance: platform admin creates four distinct accounts for one provider and manages forty numbers without reentering credentials during allocation.

## T09 — Integrate organization creation and platform allocation

- [x] Update `src/admin/CreateWorkspacePage.tsx` to select an available platform number while preserving customer-owned Vobiz setup.
- [x] Update backend organization creation to accept a platform inventory reference behind the default-off feature flag.
- [x] Reserve the inventory number in the organization-creation transaction; conflicts roll back organization creation.
- [ ] Perform external provisioning after commit through recoverable jobs. Current registration represents an existing number and does not call the provider API.
- [ ] Update `src/admin/OrgDetailPanel.tsx` and platform number routes to assign existing inventory to an organization/workspace.
- [x] Surface platform-managed ownership and the current non-routable status during creation; improve conflict errors and readiness after the shared routing/provisioning model is implemented.

Depends on: T04, T08.
Acceptance: creation and later allocation use the same connector inventory; a concurrent claim cannot leave a partial or falsely active allocation.

Current limitation: creation-time reservation is not added to `virtual_numbers`; the dialer has a separate selector for ready, assigned Vobiz numbers. Number readiness is attested by an authorized connector owner and is not verified against provider APIs. Inbound routing and staging migration/end-to-end validation remain pending. Keep both connector routing flags disabled until staging validation is complete.

## T10 — Extend Organization Admin and number selection

- [x] Extend `src/components/SettingsView.tsx` with separate multiple own-account management while preserving existing Vobiz fields and credential-entry behavior.
- [ ] Show platform-assigned numbers separately, with provider, connector label and managed-by-platform ownership.
- [ ] Permit authorized routing/agent changes without granting platform account credential or release permissions.
- [ ] Require account selection when adding own numbers; disconnect targets an account ID rather than all channels of one provider type.
- [ ] Update dialer/campaign number selectors and default-number configuration to use assignment IDs and capabilities.
- [ ] Enforce ownership rules server-side in existing generic number-save/delete routes as well as new APIs.

Depends on: T03–T06, T09.
Acceptance: own accounts and platform numbers coexist; one account can be disconnected without affecting others, and generic settings saves cannot overwrite platform allocations.

Current limitation: organization-owned ready numbers are selectable for outbound Vobiz calls; inbound routing and agent-specific connector assignment remain pending. The feature flags remain default-off until staging validation is complete.

## T11 — Migrate existing Vobiz data safely

- [ ] Inventory legacy channels and virtual numbers with a dry-run report containing no credentials.
- [ ] Identify ownership from reliable evidence; require operator classification for ambiguous accounts created with platform-supplied credentials.
- [ ] Deduplicate verified account identities without merging across ownership boundaries automatically.
- [ ] Backfill accounts, number references and assignments idempotently; flag unverified numbers and duplicate ownership for review.
- [ ] Provide a compatible transition path, then switch runtime and UI to the new model after reconciliation.
- [ ] Document feature gates, backups, deployment order, verification and rollback constraints for newly created multi-account data.

Depends on: T02, T06, T07, T09, T10.
Acceptance: migrated data reconciles with legacy inventory, no ambiguous account is silently classified, and a repeated migration creates no duplicates.

## T12 — Verify abstraction and release

- [ ] Add a second test provider adapter with different credentials, number IDs, capabilities and webhook format; do not integrate live Twilio as part of this task.
- [ ] Run contract tests against Vobiz and the test adapter to demonstrate shared services and screens need no provider branches.
- [ ] Test tenant/workspace isolation, duplicate allocation races, secret redaction, disable/rotation, provisioning retries and account-specific disconnect.
- [ ] Test inbound/outbound calls, callbacks after restart, duplicate events, historical assignments, hangups and campaign retries.
- [ ] Test mixed account billing, reservation/settlement and immutable historical charge treatment.
- [ ] Run relevant backend tests, frontend tests and production build; document staging end-to-end validation and operational recovery.

Depends on: T01–T11. Contract and security tests should be developed alongside their owning tasks.
Acceptance: provider independence is demonstrated with a second adapter, existing Vobiz behavior remains compatible, and deployment/migration instructions are reviewable.

## Suggested execution order

1. Foundation: T01 → T02 → T03 → T04 → T05.
2. Runtime and billing: T06 → T07.
3. Administration: T08 → T09 → T10; T08 can begin after its API dependencies are ready.
4. Migration and release: T11 → T12.

Backend root: `/Users/sanjay/Documents/chiefxai/crm-backend-test`.
Frontend root: `/Users/sanjay/Documents/chiefxai/com-frontend-test`.
