# Provider usage lifecycle (BILL-16)

`src/billing/adapters/usage/providerLifecycle.js` defines an opt-in provider
boundary for reserve, extend, price-and-record, settle, and release. Provider
events require stable source/component/revision identities, workspace scope,
measured quantities, an explicit versioned purchased credit rate, and the
immutable rate snapshot. INR estimates cannot become payable credits through
this adapter. Call durations can be bounded before they are accepted.

Credit enforcement is disabled by default. Enabling the adapter requires a
complete billing runtime and an explicit rollout decision. The current Vobiz
and Gemini paths only have legacy INR cost snapshots; no purchased credit-rate
mapping is configured, so their existing report and legacy recharge behavior
must remain in effect. Other telephony and AI providers remain unsupported.

The reservation recovery repository is a bounded, read-only scan of expired
open holds. The recovery job first asks a provider-specific reconciler for
state. It releases only when the reconciler confirms `no_billable_work`, sends
billable work to a provider settlement callback, and keeps holds for unknown
state or failures. Provider callbacks must persist the priced event before
settlement and must not report `no_billable_work` until the provider has
reached a terminal state and its usage delivery window is complete. This keeps
delayed costs from losing their reservation or being released prematurely.

The lifecycle and recovery modules are dependency-injected building blocks.
They are not registered in the live Vobiz/Gemini execution paths or scheduled
until the app-level billing runtime can supply its authorization, entitlement,
rate, provider reconciliation, and UoW dependencies. No unsupported provider
is silently switched to credit enforcement.
