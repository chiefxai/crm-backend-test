// src/telephony/callFinalizerRegistry.js
//
// Shared per-call "finalize this call now" registry, used by every provider
// proxy (twilioProxy.js, vobizProxy.js, piopiyProxy.js, ...).
//
// Each provider's media-stream session closure defines its own finalizeCall()
// (uploads the recording, enqueues post-call processing, and broadcasts the
// call_completed event the outbound dialer's auto-dial-next-target listens
// for). That closure previously only ran off the stream WebSocket's "stop"/
// "close" event. When the remote party hangs up but the provider is slow to
// tear down the WS, finalizeCall() never fired until the agent manually hung
// up — stalling the dialer on the current target.
//
// A provider's own call-status webhook (Twilio's StatusCallback, Vobiz's
// Hangup event, ...) is the authoritative end-of-call signal and can arrive
// before, after, or racing with the WS close. Each provider proxy registers
// its finalizeCall() closure here (keyed by the provider's own call id) as
// soon as the stream starts, and the webhook route calls finalize(callId) to
// invoke it directly. finalizeCall() implementations must guard themselves
// against double-invocation (an `isFinalized` flag) since both the webhook
// and the WS-close path may call it.
const { bindScope } = require('../workspaces/scope');
function createCallFinalizerRegistry() {
  const finalizers = new Map();

  return {
    // Register the finalizeCall() closure for a call once its stream starts.
    register(callId, finalizeFn) {
      finalizers.set(callId, bindScope(finalizeFn));
    },
    // Drop the registration once the call has been finalized (called from
    // inside finalizeCall() itself, alongside its other per-call cleanup).
    unregister(callId) {
      finalizers.delete(callId);
    },
    has(callId) {
      return finalizers.has(callId);
    },
    // Invoke the registered finalizeCall() for callId, if any. Returns
    // whether a finalizer was found — a webhook can use this to tell "call
    // was connected, now finalized" apart from "call never connected", which
    // needs its own synthetic call_logs handling instead.
    async finalize(callId) {
      const fn = finalizers.get(callId);
      if (!fn) return false;
      await fn();
      return true;
    },
  };
}

module.exports = { createCallFinalizerRegistry };
