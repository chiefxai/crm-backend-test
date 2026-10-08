'use strict';

const { createMysqlUnitOfWork } = require('../../src/billing/adapters/mysql/unitOfWork');
const operationStore = require('../../src/billing/adapters/mysql/commandOperationRepository');
const { DOMAIN_ERROR_CODES } = require('../../src/billing/contracts/errors');

const fingerprint = (hex) => `sha256:${hex.repeat(64).slice(0, 64)}`;

// This small transactional SQL double exercises the UoW and the real operation
// repository together. Its per-account lock has the same serialization
// boundary the production adapter obtains with SELECT ... FOR UPDATE.
function createFakeDatabase() {
  const accounts = new Map([['org-test', { org_id: 'org-test', status: 'active', hold_reason: null, version: 1 }]]);
  const operations = new Map();
  const effects = [];
  const tails = new Map();

  async function acquire(key) {
    const previous = tails.get(key) || Promise.resolve();
    let unlock;
    const gate = new Promise((resolve) => { unlock = resolve; });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    return () => {
      unlock();
      if (tails.get(key) === tail) tails.delete(key);
    };
  }

  const pool = {
    async connect() {
      const tx = { operationWrites: new Map(), effectWrites: [], releaseLock: null, active: false };
      return {
        async query(sql, params = []) {
          const text = String(sql).toLowerCase().replace(/\s+/g, ' ').trim();
          if (text === 'start transaction') { tx.active = true; return { rows: [] }; }
          if (text === 'commit') {
            for (const [key, value] of tx.operationWrites) operations.set(key, value);
            effects.push(...tx.effectWrites);
            tx.active = false;
            tx.releaseLock?.();
            tx.releaseLock = null;
            return { rows: [] };
          }
          if (text === 'rollback') {
            tx.operationWrites.clear();
            tx.effectWrites.length = 0;
            tx.active = false;
            tx.releaseLock?.();
            tx.releaseLock = null;
            return { rows: [] };
          }
          if (text.includes('from organization_billing_accounts')) {
            const orgId = params[0];
            if (!tx.releaseLock) tx.releaseLock = await acquire(orgId);
            const row = accounts.get(orgId);
            return { rows: row ? [{ ...row }] : [] };
          }
          if (text.includes('from billing_command_operations')) {
            const [orgId, operationId] = params;
            const key = `${orgId}:${operationId}`;
            const row = tx.operationWrites.get(key) || operations.get(key);
            return { rows: row ? [{ ...row }] : [] };
          }
          if (text.startsWith('insert into billing_command_operations')) {
            const [id, orgId, , operationId, digest, now, updatedAt] = params;
            const key = `${orgId}:${operationId}`;
            const row = {
              id, org_id: orgId, idempotency_key: operationId,
              request_fingerprint: digest, status: 'processing', result_json: null,
              version: 1, created_at: now, updated_at: updatedAt, completed_at: null,
            };
            tx.operationWrites.set(key, row);
            return { rows: [], affectedRows: 1 };
          }
          if (text.startsWith('update billing_command_operations')) {
            const [encoded, updatedAt, completedAt, orgId, operationId] = params;
            const key = `${orgId}:${operationId}`;
            const row = tx.operationWrites.get(key);
            if (!row || row.status !== 'processing') return { rows: [], affectedRows: 0 };
            tx.operationWrites.set(key, { ...row, status: 'completed', result_json: encoded, updated_at: updatedAt, completed_at: completedAt, version: row.version + 1 });
            return { rows: [], affectedRows: 1 };
          }
          if (text.startsWith('insert into test_financial_effects')) {
            tx.effectWrites.push(params[0]);
            return { rows: [], affectedRows: 1 };
          }
          throw new Error(`Unexpected SQL in fake billing DB: ${sql}`);
        },
        release() { tx.releaseLock?.(); },
      };
    },
  };
  return { pool, operations, effects };
}

function createHarness() {
  const database = createFakeDatabase();
  let id = 0;
  const clock = { now: () => new Date('2026-10-08T00:00:00.000Z') };
  const idSource = { newId: () => `op-${++id}` };
  const unitOfWork = createMysqlUnitOfWork({ pool: database.pool, operationStore, idSource, clock, sleep: async () => {} });
  return { ...database, unitOfWork };
}

describe('MySQL financial UnitOfWork contract', () => {
  test('concurrent same-key requests execute the command once and replay its committed result', async () => {
    const { unitOfWork, effects } = createHarness();
    let callbackCount = 0;
    const callback = async (tx) => {
      callbackCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tx.query('INSERT INTO test_financial_effects (effect) VALUES (?)', ['posted-once']);
      return { postingId: 'posting-1', balance: '125.500000' };
    };
    const args = { orgId: 'org-test', operationId: 'same-key', requestFingerprint: fingerprint('a'), callback };

    const [first, second] = await Promise.all([
      unitOfWork.runFinancial(args),
      unitOfWork.runFinancial(args),
    ]);

    expect(first).toEqual({ postingId: 'posting-1', balance: '125.500000' });
    expect(second).toEqual(first);
    expect(callbackCount).toBe(1);
    expect(effects).toEqual(['posted-once']);
  });

  test('same idempotency key with a different request fingerprint conflicts', async () => {
    const { unitOfWork } = createHarness();
    const base = { orgId: 'org-test', operationId: 'body-key', callback: async () => ({ accepted: true }) };
    await unitOfWork.runFinancial({ ...base, requestFingerprint: fingerprint('b') });

    await expect(unitOfWork.runFinancial({ ...base, requestFingerprint: fingerprint('c') }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT });
  });

  test('callback failure rolls back both the operation record and transactional side effects', async () => {
    const { unitOfWork, operations, effects } = createHarness();
    await expect(unitOfWork.runFinancial({
      orgId: 'org-test', operationId: 'rollback-key', requestFingerprint: fingerprint('d'),
      callback: async (tx) => {
        await tx.query('INSERT INTO test_financial_effects (effect) VALUES (?)', ['must-rollback']);
        throw new Error('simulated posting failure');
      },
    })).rejects.toThrow('simulated posting failure');

    expect(operations.size).toBe(0);
    expect(effects).toEqual([]);
  });
});

const runMysql = process.env.MYSQL_INTEGRATION_TESTS === '1';
(runMysql ? describe : describe.skip)('MySQL integration: financial UnitOfWork concurrency', () => {
  let pool;
  let db;
  let orgId;
  const operationIds = [`same-${Date.now()}`, `conflict-${Date.now()}`];

  beforeAll(async () => {
    const mysqlUrl = process.env.MYSQL_URL;
    if (!mysqlUrl) throw new Error('MYSQL_URL is required for billing MySQL integration tests.');
    const databaseName = decodeURIComponent(new URL(mysqlUrl).pathname.replace(/^\//, '')).toLowerCase();
    if (!/(^|[_-])test([_-]|$)/.test(databaseName) || /prod(uction)?/.test(databaseName)) {
      throw new Error('Refusing billing integration tests: MYSQL_URL must target an explicitly named disposable *_test database.');
    }

    // The explicit URL guard above ensures migrations and unique fixture rows
    // can only be created in a disposable test database.
    db = require('../../src/db/adapters/mysql');
    await db.ready;
    pool = require('../../src/db/pool').pool;
    orgId = `billing-itest-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const now = new Date();
    await pool.query(
      `INSERT INTO organizations (id,name,workspace_name,industry,subscription_plan,status,created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [orgId, `Billing test ${orgId}`, 'Billing test workspace', 'lending', 'test', 'Active', now.toISOString()],
    );
    await pool.query(
      `INSERT INTO organization_billing_accounts (org_id,status,created_at,updated_at)
       VALUES (?,'active',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))`,
      [orgId],
    );
  }, 30000);

  afterAll(async () => {
    if (!pool || !orgId) return;
    try {
      await pool.query('DELETE FROM billing_command_operations WHERE org_id=?', [orgId]);
      await pool.query('DELETE FROM organization_billing_accounts WHERE org_id=?', [orgId]);
      await pool.query('DELETE FROM organizations WHERE id=?', [orgId]);
    } finally {
      if (db && typeof db.close === 'function') await db.close();
    }
  }, 30000);

  test('serializes concurrent identical commands and rejects a changed fingerprint', async () => {
    const { createMysqlUnitOfWork } = require('../../src/billing/adapters/mysql/unitOfWork');
    const operationStore = require('../../src/billing/adapters/mysql/commandOperationRepository');
    let callbackCount = 0;
    let id = 0;
    const unitOfWork = createMysqlUnitOfWork({
      pool,
      operationStore,
      idSource: { newId: () => `billing-operation-${orgId}-${++id}` },
      clock: { now: () => new Date() },
    });
    const callback = async () => {
      callbackCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { committed: true, callbackCount };
    };
    const sameKey = {
      orgId,
      operationId: operationIds[0],
      requestFingerprint: fingerprint('e'),
      callback,
    };

    const [first, second] = await Promise.all([
      unitOfWork.runFinancial(sameKey),
      unitOfWork.runFinancial(sameKey),
    ]);
    expect(first).toEqual({ committed: true, callbackCount: 1 });
    expect(second).toEqual(first);
    expect(callbackCount).toBe(1);

    await unitOfWork.runFinancial({ ...sameKey, operationId: operationIds[1], requestFingerprint: fingerprint('f') });
    await expect(unitOfWork.runFinancial({ ...sameKey, operationId: operationIds[1], requestFingerprint: fingerprint('0') }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT });
  });
});
