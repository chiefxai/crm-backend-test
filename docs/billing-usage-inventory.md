# Billable usage inventory

Status: BILL-12 contract and adapter delivered; provider paths remain in report
mode until funding enforcement is released. Do not infer a credit debit from a
legacy INR report or reservation.

BILL-16 adds a dependency-injected provider lifecycle adapter and a
provider-reconciled reservation recovery job. They are not registered in live
provider paths or the scheduler because no purchased credit-rate mapping or
application billing runtime is configured. See
`docs/billing-provider-lifecycle.md` for the rollout restriction.

## Canonical usage contract

`src/billing/modules/funding/usageEvents.js` defines immutable usage event v1.
Every event has an organization/workspace scope, source type and ID, operation
ID, component key, positive revision, measured quantity, status, recorded and
occurred timestamps, a fixed pricing snapshot, and an amount in the explicit
credit asset. The database uniqueness key is
`(org_id, source_type, source_id, component_key, revision)`. A correction or
late-arriving component uses a higher revision; an existing revision cannot be
edited. Event IDs are deterministic from the same natural key.

Statuses:

- `payable`: only allowed with a positive amount and a versioned, explicit
  `credit_rate` snapshot. Historical replay uses that snapshot, never today's
  plan or rate.
- `estimated`: stores zero payable credits. Existing cost estimates and their
  INR/currency detail remain in the snapshot for display and reconciliation.
- `excluded`: stores zero payable credits for measured work explicitly outside
  the purchased credit policy.

`src/billing/adapters/usage/rating.js` provides exact integer rating against a
versioned credit rate. It requires the measured quantity, rate basis, amount,
asset, scale, and rounding rule as explicit inputs. The MySQL repository accepts
the caller's billing transaction, writes once, returns an identical retry as a
duplicate, and raises an idempotency conflict if a revision is reused with
different content. The existing `billing_usage_events` schema from BILL-02 is
used; no new migration is required for this task.

`src/billing/adapters/usage/legacySnapshots.js` maps finalized call billing and
AI session snapshots into `estimated` events with zero payable credits. It
preserves their INR amounts and rate details only as reporting metadata.

## Current paths

| Usage path | Current measurement and snapshot | BILL-12 classification | Integration status / owner |
| --- | --- | --- | --- |
| Vobiz outbound telephony | `src/crm/rechargeBilling.js` estimates a reservation before dialing and settles from final duration; `src/billing/callBillingService.js` snapshots Vobiz rate details. | Reservation is an authorization estimate. A final billable telephony component must use the explicit purchased credit rate; the INR report is estimated until converted by policy. | Legacy snapshot adapter available. Legacy recharge enforcement remains active for its existing mode. New settlement primitives are ready; provider authorization/settlement wiring is BILL-16. Owner: Vobiz adapter + funding application. |
| Vobiz inbound telephony | Inbound number ownership is resolved in `src/telephony/vobiz/routes.js`; `src/telephony/callFinalizer.js` records duration and call billing. No outbound recharge reservation is created. | Final duration can be measured; the legacy cost report is not a credit debit. | Report only. Settlement primitives are ready; new call-path authorization and settlement wiring is BILL-16. Owner: Vobiz adapter + funding application. |
| Gemini Live voice AI | `src/ai/geminiUsageTracker.js` records cumulative token totals and locks a platform rate snapshot at finalization; `src/routes/aiUsage.js` labels its reports estimated. Vobiz opens sessions in `src/telephony/vobiz/vobizProxy.js`. | Platform rate snapshot is historical report data in INR, not a credit amount. Preserve it as `estimated` until a credit rate version is explicitly selected. | Legacy snapshot adapter available; usage report wired for Gemini Live/Vobiz. Event, rating and settlement primitives are ready; payable event and provider lifecycle wiring is BILL-16. Owner: Gemini usage adapter. |
| Post-call AI agents | `src/telephony/callFinalizer.js` records known token totals through the same tracker with provider key `gemini-postcall`; the work is asynchronous after call finalization. | Separate component from live voice; legacy INR snapshot is not payable credit usage. Each agent/model component needs a stable operation/component identity before charging. | Report only; async completion can race call billing report refresh. Event, rating and settlement primitives are ready; provider callback wiring is BILL-16. Owner: post-call usage adapter. |
| Other non-call AI (text replies, conversation intelligence, embeddings/search) | `src/ai/textReply.js`, `src/ai/conversationIntelligence.js`, and `src/ai/vectorStore.js` call AI providers outside the usage tracker. | Unsupported/unmetered for credit billing; do not synthesize usage from current estimates. | Explicit integration gap. Add token/operation callbacks and stable source IDs before enabling payable usage. Owner: each AI integration adapter. |
| Other telephony providers | The current registry exposes connector capabilities in `src/telephony/registry.js`; usage tracking/reservation calls were found only in the Vobiz implementation. | Unsupported/unmetered for the new credit ledger. Provider cost estimates must remain informational. | Explicit integration gap. Add provider-specific measurement and idempotency adapter before enabling. |
| Customer-managed provider credentials / billing | AI credentials may be organization-specific through `src/ai/googleAiClient.js`; Google-side billing is not confirmed by the platform usage tracker. | Any platform-computed cost is an estimate of customer provider spend, never a platform payable credit event. Mark `estimated` or `excluded`, with zero payable amount. | Explicitly excluded from platform credit collection pending a purchased platform service/rate. Owner: provider credential adapter and reconciliation policy. |

## Release boundary and next work

BILL-12 through BILL-15 establish immutable usage events, funding reservations,
postpaid exposure, settlement, and invoicing. They do not emit payable events
from telephony or AI call paths or turn on provider enforcement. BILL-16 wires
each provider after it has a stable operation ID, workspace ID, usage
component/revision policy, and an explicit purchased credit rate.

For post-call work, a late component or correction must use a new component key
or revision and then settle only the incremental difference. A report refresh
must never overwrite the prior priced usage event.
