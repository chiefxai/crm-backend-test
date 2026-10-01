// Provider-agnostic realtime turn safety primitives.
//
// Providers should normalize their events into these guards instead of
// implementing provider-specific duplicate/replay rules.
//
// - tool calls: suppress duplicate deliveries of the same logical call.
// - generations: give every spoken response a monotonic generation token so
//   stale audio can never be appended after a caller turn/interruption.

function stableNormalize(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stableNormalize(value[key]);
      return out;
    }, {});
  }
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  return value;
}

function logicalToolCallKey(call) {
  const name = String(call?.name || "").trim();
  const args = stableNormalize(call?.args || {});
  return `${name}:${JSON.stringify(args)}`;
}

function createToolCallDeduper({ ttlMs = 10000 } = {}) {
  const seen = new Map();

  function prune(now = Date.now()) {
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= now) seen.delete(key);
    }
  }

  return {
    key: logicalToolCallKey,
    claim(call, { eventId = null } = {}) {
      const now = Date.now();
      prune(now);

      // A provider event may expose the same function call through more than
      // one envelope. Prefer the provider call id when available, while the
      // logical key also protects against the same call being re-issued with
      // a fresh id.
      const providerId = call?.id ? `id:${String(call.id)}` : null;
      const logicalKey = `logical:${logicalToolCallKey(call)}`;
      const eventKey = eventId ? `event:${String(eventId)}:${logicalKey}` : null;

      if ((providerId && seen.has(providerId)) ||
          seen.has(logicalKey) ||
          (eventKey && seen.has(eventKey))) {
        return false;
      }

      const expiresAt = now + ttlMs;
      if (providerId) seen.set(providerId, expiresAt);
      seen.set(logicalKey, expiresAt);
      if (eventKey) seen.set(eventKey, expiresAt);
      return true;
    },
    clear() {
      seen.clear();
    },
  };
}

function createGenerationGate() {
  let generation = 0;

  return {
    current() {
      return generation;
    },
    begin(reason = "new-turn") {
      generation += 1;
      return generation;
    },
    isCurrent(token) {
      return token === generation;
    },
    invalidate(reason = "invalidate") {
      generation += 1;
      return generation;
    },
  };
}

module.exports = {
  stableNormalize,
  logicalToolCallKey,
  createToolCallDeduper,
  createGenerationGate,
};
