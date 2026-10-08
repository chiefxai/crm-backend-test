'use strict';

const EVENT_TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;

function createBillingJobDispatchRegistry(handlers = {}) {
  const entries = new Map();
  const registry = Object.freeze({ register, resolve, list });
  const source = handlers instanceof Map ? handlers.entries() : Object.entries(handlers);
  for (const [eventType, handler] of source) register(eventType, handler);

  function register(eventType, handler) {
    if (typeof eventType !== 'string' || !EVENT_TYPE_PATTERN.test(eventType)) {
      throw new TypeError('Billing job eventType must be a valid event type string.');
    }
    if (typeof handler !== 'function') throw new TypeError(`Billing job handler for ${eventType} must be a function.`);
    if (entries.has(eventType)) throw new Error(`Billing job handler already registered for ${eventType}.`);
    entries.set(eventType, handler);
    return registry;
  }

  function resolve(eventType) { return entries.get(eventType) || null; }
  function list() { return [...entries.keys()].sort(); }

  return registry;
}

module.exports = { createBillingJobDispatchRegistry, EVENT_TYPE_PATTERN };
