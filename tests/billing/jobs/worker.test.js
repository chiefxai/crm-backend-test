'use strict';

const { createBillingJobDispatchRegistry } = require('../../../src/billing/adapters/jobs/dispatchRegistry');
const { createBillingJobWorker, createBillingJobWorkerEntrypoint, eventFingerprint, eventOperationId } = require('../../../src/billing/adapters/jobs/worker');

function event(orgId, eventId, eventType = 'billing.test') {
  return { orgId, eventId, eventType, leaseToken: `lease-${eventId}`, fencingToken: 1 };
}

function fakeStore(orgEvents) {
  const calls = { claims: [], acks: [], failures: [] };
  return {
    calls,
    async listReadyOrganizations({ limit, afterOrgId }) {
      return Object.keys(orgEvents).sort().filter((id) => !afterOrgId || id > afterOrgId).slice(0, limit);
    },
    async claimBatch(args) {
      calls.claims.push(args);
      const queue = orgEvents[args.orgId] || [];
      return queue.splice(0, args.limit).map((row) => ({ ...row, workerId: args.workerId }));
    },
    async ack(args) { calls.acks.push(args); },
    async fail(claim, options) { calls.failures.push({ ...claim, ...options }); },
  };
}

function transactionalDependencies() {
  const inboxRows = new Set();
  let id = 0;
  return {
    consumerRunner: {
      async runConsumer({ orgId, callback }) { return callback({ orgId }); },
    },
    inboxStore: {
      async process(tx, input, handler) {
        const key = `${input.orgId}:${input.consumerKey}:${input.eventId}`;
        if (inboxRows.has(key)) return { processed: false, duplicate: true, resultReference: null };
        const result = await handler(tx);
        inboxRows.add(key);
        return { processed: true, duplicate: false, resultReference: null, result };
      },
    },
    idSource: { newId: (prefix) => `${prefix}-${++id}` },
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
  };
}

function createWorker(store, registry, options = {}) {
  return createBillingJobWorker({ outboxStore: store, registry, workerId: 'test-worker', ...transactionalDependencies(), ...options });
}

describe('billing job dispatch registry', () => {
  test('validates unique event handlers and resolves registered event types', () => {
    const registry = createBillingJobDispatchRegistry({ 'billing.test': async () => {} });
    expect(typeof registry.resolve('billing.test')).toBe('function');
    expect(registry.resolve('billing.missing')).toBeNull();
    expect(registry.list()).toEqual(['billing.test']);
    expect(() => registry.register('billing.test', async () => {})).toThrow(/already registered/);
    expect(() => registry.register('bad type', async () => {})).toThrow(/eventType/);
  });
});

describe('billing job worker', () => {
  test('shares a bounded batch round-robin across organization backlogs and fenced-acks each event', async () => {
    const store = fakeStore({
      orgA: Array.from({ length: 5 }, (_, i) => event('orgA', `a${i}`)),
      orgB: Array.from({ length: 5 }, (_, i) => event('orgB', `b${i}`)),
    });
    const processed = [];
    const registry = createBillingJobDispatchRegistry({ 'billing.test': async (job) => processed.push(job.eventId) });
    const worker = createWorker(store, registry, { workerId: 'worker-1', batchSize: 4 });

    const result = await worker.runOnce();

    expect(result.claimed).toBe(4);
    expect(store.calls.claims.map((call) => call.orgId)).toEqual(['orgA', 'orgB', 'orgA', 'orgB']);
    expect(processed).toEqual(['a0', 'b0', 'a1', 'b1']);
    expect(store.calls.acks).toHaveLength(4);
    expect(store.calls.acks[0]).toEqual({ eventId: 'a0', workerId: 'worker-1', leaseToken: 'lease-a0', fencingToken: 1 });
  });

  test('schedules handler failures with bounded retry policy and stable lease fencing values', async () => {
    const store = fakeStore({ orgA: [event('orgA', 'retry-me')] });
    const registry = createBillingJobDispatchRegistry({ 'billing.test': async () => { throw Object.assign(new Error('temporary'), { code: 'SMTP_UNAVAILABLE' }); } });
    const worker = createWorker(store, registry, { workerId: 'worker-2', maxAttempts: 4, baseDelayMs: 20, maxDelayMs: 500 });

    const result = await worker.runOnce();

    expect(result.retryScheduled).toBe(1);
    expect(store.calls.failures).toEqual([{
      eventId: 'retry-me', workerId: 'worker-2', leaseToken: 'lease-retry-me', fencingToken: 1,
      errorCode: 'SMTP_UNAVAILABLE', maxAttempts: 4, baseDelayMs: 20, maxDelayMs: 500,
    }]);
    expect(store.calls.acks).toHaveLength(0);
  });

  test('advances the bounded organization scan cursor between ticks', async () => {
    const store = fakeStore({
      orgA: [event('orgA', 'a1')],
      orgB: [event('orgB', 'b1')],
      orgC: [event('orgC', 'c1')],
    });
    const registry = createBillingJobDispatchRegistry({ 'billing.test': async () => {} });
    const worker = createWorker(store, registry, { workerId: 'worker-cursor', batchSize: 1, maxOrganizations: 2 });

    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();

    expect(store.calls.claims.map((call) => call.orgId)).toEqual(['orgA', 'orgB', 'orgC']);
  });

  test('reclaimed delivery after an ack failure replays its transaction result without rerunning the handler', async () => {
    const base = event('orgA', 'crash-window');
    const claims = [base, { ...base, leaseToken: 'new-lease', fencingToken: 2 }];
    const store = {
      async listReadyOrganizations() { return ['orgA']; },
      async claimBatch() { return [claims.shift()]; },
      async ack() { if (claims.length === 1) throw new Error('connection lost after handler commit'); },
      async fail() { throw new Error('ack failure should wait for lease expiry'); },
    };
    let calls = 0;
    const registry = createBillingJobDispatchRegistry({ 'billing.test': async () => { calls += 1; } });
    const worker = createWorker(store, registry, { workerId: 'crash-worker', batchSize: 1 });

    expect((await worker.runOnce()).ackFailed).toBe(1);
    expect((await worker.runOnce()).completed).toBe(1);
    expect(calls).toBe(1);
    expect(eventFingerprint(base)).toBe(eventFingerprint({ ...base, leaseToken: 'rotated', fencingToken: 9, attempts: 7 }));
    expect(eventOperationId(base)).toBe(eventOperationId({ ...base, leaseToken: 'rotated', fencingToken: 9 }));
  });

  test('dead-letters unregistered event types without invoking a handler', async () => {
    const store = fakeStore({ orgA: [event('orgA', 'poison', 'billing.unhandled')] });
    const worker = createWorker(store, createBillingJobDispatchRegistry(), { workerId: 'worker-3' });
    const result = await worker.runOnce();
    expect(result.unsupported).toBe(1);
    expect(store.calls.failures[0]).toMatchObject({ eventId: 'poison', errorCode: 'UNSUPPORTED_EVENT_TYPE', maxAttempts: 1 });
  });

  test('provides a one-tick entrypoint and rejects unsafe limits', async () => {
    const store = fakeStore({});
    const entrypoint = createBillingJobWorkerEntrypoint({ outboxStore: store, registry: createBillingJobDispatchRegistry(), workerId: 'worker-4', ...transactionalDependencies() });
    await expect(entrypoint.runBillingJobsOnce()).resolves.toMatchObject({ claimed: 0 });
    expect(() => createWorker(store, createBillingJobDispatchRegistry(), { workerId: 'worker-5', batchSize: 0 })).toThrow(/batchSize/);
    expect(() => createBillingJobWorker({ outboxStore: store, registry: createBillingJobDispatchRegistry(), workerId: 'worker-6' })).toThrow(/transaction-bound consumer runner/);
  });
});
