'use strict';

const { createMysqlCreditRepository } = require('../../../src/billing/modules/credits/repositories/mysqlCreditRepository');
const {
  planIssueGrant, planTransfer, planReserve, planConsume, planRelease, planExpire, planReverse,
} = require('../../../src/billing/modules/credits/domain');
const { createTransactionContext } = require('../../../src/billing/kernel/transactionContext');
const { organizationScope, workspaceScope } = require('../../../src/billing/kernel/scope');
const { DOMAIN_ERROR_CODES } = require('../../../src/billing/contracts/errors');
const accountPurposeMigration = require('../../../src/db/migrations/2026100715-billing-credit-account-purpose');

const orgId = 'org-ledger-test';
const now = '2026-10-08T12:00:00.000Z';
const expiresAt = '2026-11-01T00:00:00.000Z';
const actor = { type: 'user', id: 'admin-ledger-test' };
const credit = (units) => ({ asset: 'CREDIT', units: String(units), scale: 0 });
const ids = (() => { let next = 0; return { newId: (kind) => `${kind}-${++next}` }; })();

// This query adapter intentionally models transaction-local state and commit / rollback,
// while leaving SQL interpretation to the production MySQL repository. It is useful for
// integration invariants but does not simulate MySQL locking, isolation, or concurrency.
function createTransactionalStore({ failOnceOn } = {}) {
  const state = { accounts: new Map(), grants: new Map(), positions: new Map(), journals: new Map(), lines: [] };
  const keyPosition = (org, grant, account) => `${org}|${grant}|${account}`;
  let failurePending = Boolean(failOnceOn);

  function cloneState(input) {
    return {
      accounts: new Map([...input.accounts].map(([k, v]) => [k, { ...v }])),
      grants: new Map([...input.grants].map(([k, v]) => [k, { ...v }])),
      positions: new Map([...input.positions].map(([k, v]) => [k, { ...v }])),
      journals: new Map([...input.journals].map(([k, v]) => [k, { ...v }])),
      lines: input.lines.map((v) => ({ ...v })),
    };
  }

  function begin() {
    const working = cloneState(state);
    const client = {
      async query(sqlValue, params = []) {
        const sql = String(sqlValue).replace(/\s+/g, ' ').trim();
        if (failurePending && failOnceOn && failOnceOn.test(sql)) {
          failurePending = false;
          throw new Error('injected transactional write failure');
        }
        if (/^SELECT id,org_id,account_type,owner_id,workspace_id,account_purpose,asset,scale,status,version FROM billing_credit_accounts/i.test(sql)) {
          const [org, id] = params; const row = working.accounts.get(`${org}|${id}`);
          return { rows: row ? [{ ...row }] : [] };
        }
        if (/^SELECT id,asset,scale,status,account_purpose FROM billing_credit_accounts/i.test(sql)) {
          const [org, id] = params; const row = working.accounts.get(`${org}|${id}`);
          return { rows: row ? [{ id: row.id, asset: row.asset, scale: row.scale, status: row.status, account_purpose: row.account_purpose }] : [] };
        }
        if (/^SELECT id,asset,scale,status,effective_at,expires_at FROM billing_credit_grants/i.test(sql)) {
          const [org, id] = params; const row = working.grants.get(`${org}|${id}`);
          return { rows: row ? [{ id: row.id, asset: row.asset, scale: row.scale, status: row.status, effective_at: row.effective_at, expires_at: row.expires_at }] : [] };
        }
        if (/^SELECT id,operation_type,source_type,source_id,actor_type,actor_id,reason FROM billing_journals/i.test(sql)) {
          const [org, operationId] = params; const row = working.journals.get(`${org}|${operationId}`);
          return { rows: row ? [{ ...row }] : [] };
        }
        if (/^SELECT account_id,grant_id,amount_units,asset,scale,entry_type FROM billing_journal_lines/i.test(sql)) {
          const [, journalId] = params;
          return { rows: working.lines.filter((line) => line.journal_id === journalId).map((line) => ({ ...line })) };
        }
        if (/^SELECT id,balance_units,reserved_units,version FROM billing_credit_positions/i.test(sql)) {
          const [org, grant, account] = params; const row = working.positions.get(keyPosition(org, grant, account));
          return { rows: row ? [{ id: row.id, balance_units: row.balance_units, reserved_units: row.reserved_units, version: row.version }] : [] };
        }
        if (/^INSERT INTO billing_credit_grants/i.test(sql)) {
          const [id, org_id, grant_kind, source_type, source_id, source_event_key, period_id, payment_request_id,
            amount_units, asset, scale, effective_at, expires_at, created_at] = params;
          working.grants.set(`${org_id}|${id}`, { id, org_id, grant_kind, source_type, source_id, source_event_key,
            period_id, payment_request_id, status: 'active', amount_units: String(amount_units), asset, scale: Number(scale), effective_at, expires_at, created_at });
          return { affectedRows: 1 };
        }
        if (/^INSERT INTO billing_journals/i.test(sql)) {
          const [id, org_id, operation_id, operation_type, source_type, source_id, actor_type, actor_id, reason, created_at] = params;
          const row = { id, org_id, operation_id, operation_type, source_type, source_id, actor_type, actor_id, reason, created_at };
          working.journals.set(`${org_id}|${operation_id}`, row);
          return { affectedRows: 1 };
        }
        if (/^INSERT INTO billing_journal_lines/i.test(sql)) {
          const [id, org_id, journal_id, line_number, account_id, grant_id, entry_type, amount_units, asset, scale, created_at] = params;
          working.lines.push({ id, org_id, journal_id, line_number, account_id, grant_id, entry_type,
            amount_units: String(amount_units), asset, scale: Number(scale), created_at });
          return { affectedRows: 1 };
        }
        if (/^INSERT INTO billing_credit_positions/i.test(sql)) {
          const [id, org_id, grant_id, account_id, asset, scale, balance_units, reserved_units, updated_at] = params;
          working.positions.set(keyPosition(org_id, grant_id, account_id), { id, org_id, grant_id, account_id,
            asset, scale: Number(scale), balance_units: String(balance_units), reserved_units: String(reserved_units), version: 0, updated_at });
          return { affectedRows: 1 };
        }
        if (/^UPDATE billing_credit_positions SET balance_units=/i.test(sql)) {
          const [balance_units, reserved_units, updated_at, org, id, version] = params;
          const row = [...working.positions.values()].find((item) => item.org_id === org && item.id === id && item.version === Number(version));
          if (!row) return { affectedRows: 0 };
          row.balance_units = String(balance_units); row.reserved_units = String(reserved_units); row.version += 1; row.updated_at = updated_at;
          return { affectedRows: 1 };
        }
        if (/^UPDATE billing_credit_grants SET status=/i.test(sql)) {
          const [status, org, id, expectedStatus] = params; const row = working.grants.get(`${org}|${id}`);
          if (!row || row.status !== expectedStatus) return { affectedRows: 0 };
          if (row.status === status) return { affectedRows: 0 };
          row.status = status; return { affectedRows: 1 };
        }
        throw new Error(`Unimplemented test SQL: ${sql}`);
      },
    };
    const tx = createTransactionContext(client, { orgId, operationId: 'test-transaction' });
    return {
      tx,
      commit() {
        state.accounts = working.accounts; state.grants = working.grants; state.positions = working.positions;
        state.journals = working.journals; state.lines = working.lines;
      },
      rollback() {},
    };
  }

  const accountSpecs = [
    ['org-admin', 'organization', orgId, null], ['workspace-a', 'workspace', 'workspace-a', 'workspace-a'],
    ['funding-clearing', 'organization', orgId, null], ['usage-clearing', 'organization', orgId, null],
    ['expiry-clearing', 'organization', orgId, null],
  ];
  for (const [id, account_type, owner_id, workspace_id] of accountSpecs) {
    const account_purpose = id === 'funding-clearing' ? 'funding_clearing'
      : id === 'usage-clearing' ? 'usage_clearing' : id === 'expiry-clearing' ? 'expiry_clearing' : 'pool';
    state.accounts.set(`${orgId}|${id}`, { id, org_id: orgId, account_type, owner_id, workspace_id, account_purpose, asset: 'CREDIT', scale: 0, status: 'active', version: 0 });
  }
  return { state, begin, position: (grantId, accountId) => state.positions.get(keyPosition(orgId, grantId, accountId)) };
}

async function commitPlan(repo, store, plan) {
  const transaction = store.begin();
  try {
    const result = await repo.applyJournal(transaction.tx, plan.journal ? {
      ...plan.journal,
      ...(plan.positionDeltas?.length ? { positionDeltas: plan.positionDeltas.map((delta) => ({ ...delta, asset: 'CREDIT', scale: 0 })) } : {}),
      ...(plan.grantPatch ? { grantPatch: plan.grantPatch } : {}),
    } : { ...plan.journal });
    transaction.commit();
    return result;
  } catch (error) {
    transaction.rollback();
    throw error;
  }
}

function sumBalances(store, grantId, accountIds) {
  return accountIds.reduce((sum, accountId) => sum + BigInt(store.position(grantId, accountId)?.balance_units || '0'), 0n);
}

function expectValidPositions(store) {
  for (const row of store.state.positions.values()) {
    expect(BigInt(row.balance_units)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(row.reserved_units)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(row.reserved_units)).toBeLessThanOrEqual(BigInt(row.balance_units));
  }
}

describe('credit ledger persistence invariants', () => {
  let store;
  let repo;

  beforeEach(() => {
    store = createTransactionalStore();
    repo = createMysqlCreditRepository({ idSource: ids, clock: { now: () => now } });
  });

  test('issues, transfers, reserves, consumes, releases, reverses and expires without losing provenance or reusing spent units', async () => {
    const issuedGrant = {
      id: 'grant-ledger-1', kind: 'subscription', grantKind: 'subscription', sourceType: 'payment', sourceId: 'payment-ledger-1',
      sourceEventKey: 'approval-ledger-1', amount: credit(1000), accountScope: organizationScope(orgId), effectiveAt: '2026-10-01T00:00:00.000Z', expiresAt,
    };
    const issue = planIssueGrant({ orgId, operationId: 'issue-1', grant: issuedGrant, adminAccountId: 'org-admin',
      fundingClearingAccountId: 'funding-clearing', actor, now });
    const tx = store.begin();
    await repo.createGrant(tx.tx, { orgId, grant: issuedGrant, now });
    await repo.applyJournal(tx.tx, { ...issue.journal, positionDeltas: issue.positionDeltas.map((delta) => ({ ...delta, asset: 'CREDIT', scale: 0 })) });
    tx.commit();
    expect(store.position(issuedGrant.id, 'org-admin').balance_units).toBe('1000');

    const grant = { id: issuedGrant.id, orgId, kind: 'subscription', status: 'active', amount: credit(1000), effectiveAt: issuedGrant.effectiveAt, expiresAt };
    const transfer = planTransfer({ orgId, operationId: 'transfer-1', grant,
      from: { accountId: 'org-admin', grantId: grant.id, balanceUnits: '1000', reservedUnits: '0' }, to: { id: 'workspace-a' },
      fromScope: organizationScope(orgId), toScope: workspaceScope(orgId, 'workspace-a'), amount: credit(300), actor, now });
    await commitPlan(repo, store, transfer);
    expect(sumBalances(store, grant.id, ['org-admin', 'workspace-a'])).toBe(1000n);

    const reservation = planReserve({ orgId, operationId: 'reserve-1', grant,
      position: { accountId: 'workspace-a', grantId: grant.id, balanceUnits: '300', reservedUnits: '0' },
      amount: credit(100), reservationId: 'reservation-1', actor, now });
    await commitPlan(repo, store, reservation);
    expect(store.position(grant.id, 'workspace-a')).toMatchObject({ balance_units: '300', reserved_units: '100' });

    const consume = planConsume({ orgId, operationId: 'consume-1', grant,
      position: { accountId: 'workspace-a', grantId: grant.id, balanceUnits: '300', reservedUnits: '100' },
      amount: credit(60), reservationId: 'reservation-1', usageClearingAccountId: 'usage-clearing',
      usageOccurredAt: now, actor, now });
    await commitPlan(repo, store, consume);
    expect(store.position(grant.id, 'workspace-a')).toMatchObject({ balance_units: '240', reserved_units: '40' });

    const release = planRelease({ orgId, operationId: 'release-1', grant,
      position: { accountId: 'workspace-a', grantId: grant.id, balanceUnits: '240', reservedUnits: '40' },
      amount: credit(40), reservationId: 'reservation-1', actor, now });
    await commitPlan(repo, store, release);
    expect(store.position(grant.id, 'workspace-a')).toMatchObject({ balance_units: '240', reserved_units: '0' });

    await expect(Promise.resolve().then(() => planReverse({ orgId, operationId: 'reverse-spent-transfer', originalJournal: transfer.journal, grant,
      positions: [{ accountId: 'workspace-a', grantId: grant.id, balanceUnits: '240', reservedUnits: '0' }, { accountId: 'org-admin', grantId: grant.id, balanceUnits: '700', reservedUnits: '0' }], actor, now })))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.INSUFFICIENT_CREDITS });

    const smallTransfer = planTransfer({ orgId, operationId: 'transfer-2', grant,
      from: { accountId: 'org-admin', grantId: grant.id, balanceUnits: '700', reservedUnits: '0' }, to: { id: 'workspace-a' },
      fromScope: organizationScope(orgId), toScope: workspaceScope(orgId, 'workspace-a'), amount: credit(50), actor, now });
    await commitPlan(repo, store, smallTransfer);
    const reverse = planReverse({ orgId, operationId: 'reverse-transfer-2', originalJournal: smallTransfer.journal, grant,
      positions: [{ accountId: 'workspace-a', grantId: grant.id, balanceUnits: '290', reservedUnits: '0' }, { accountId: 'org-admin', grantId: grant.id, balanceUnits: '650', reservedUnits: '0' }], actor, now });
    await commitPlan(repo, store, reverse);
    expect(store.position(grant.id, 'org-admin').balance_units).toBe('700');
    expect(store.position(grant.id, 'workspace-a').balance_units).toBe('240');
    expect(sumBalances(store, grant.id, ['org-admin', 'workspace-a'])).toBe(940n); // 60 units were consumed.

    const heldAtExpiry = planReserve({ orgId, operationId: 'reserve-at-expiry-1', grant,
      position: { accountId: 'workspace-a', grantId: grant.id, balanceUnits: '240', reservedUnits: '0' },
      amount: credit(20), reservationId: 'reservation-at-expiry', actor, now });
    await commitPlan(repo, store, heldAtExpiry);

    const expiryNow = expiresAt;
    const expiringGrant = { ...grant, status: 'active' };
    const expireAdmin = planExpire({ orgId, operationId: 'expire-admin', grant: expiringGrant,
      position: { accountId: 'org-admin', grantId: grant.id, balanceUnits: '700', reservedUnits: '0' },
      expiryClearingAccountId: 'expiry-clearing', actor: { type: 'system', id: 'expiry-worker' }, now: expiryNow });
    await commitPlan(repo, store, expireAdmin);
    const expireWorkspace = planExpire({ orgId, operationId: 'expire-workspace', grant: { ...expiringGrant, status: 'expired' },
      position: { accountId: 'workspace-a', grantId: grant.id, balanceUnits: '240', reservedUnits: '20' },
      expiryClearingAccountId: 'expiry-clearing', actor: { type: 'system', id: 'expiry-worker' }, now: expiryNow });
    await commitPlan(repo, store, expireWorkspace);
    expect(store.position(grant.id, 'org-admin').balance_units).toBe('0');
    expect(store.position(grant.id, 'workspace-a')).toMatchObject({ balance_units: '20', reserved_units: '20' });
    expect(store.state.grants.get(`${orgId}|${grant.id}`).status).toBe('expired');
    const expiredRelease = planRelease({ orgId, operationId: 'release-expired-held', grant: { ...expiringGrant, status: 'expired' },
      position: { accountId: 'workspace-a', grantId: grant.id, balanceUnits: '20', reservedUnits: '20' }, amount: credit(20),
      reservationId: 'reservation-at-expiry', expiryClearingAccountId: 'expiry-clearing',
      actor: { type: 'system', id: 'expiry-worker' }, now: expiryNow });
    await commitPlan(repo, store, expiredRelease);
    expect(store.position(grant.id, 'workspace-a')).toMatchObject({ balance_units: '0', reserved_units: '0' });
    expect(sumBalances(store, grant.id, ['org-admin', 'workspace-a'])).toBe(0n);
    expectValidPositions(store);
  });

  test('same operation is harmless, changed movements conflict, and failed writes roll back journal plus position', async () => {
    const issuedGrant = {
      id: 'grant-ledger-2', grantKind: 'topup', sourceType: 'payment', sourceId: 'payment-ledger-2', sourceEventKey: 'approval-ledger-2',
      amount: credit(500), effectiveAt: '2026-10-01T00:00:00.000Z', expiresAt: null,
    };
    const issue = planIssueGrant({ orgId, operationId: 'issue-2', grant: { ...issuedGrant, kind: 'topup', accountScope: organizationScope(orgId) },
      adminAccountId: 'org-admin', fundingClearingAccountId: 'funding-clearing', actor, now });
    const tx = store.begin();
    await repo.createGrant(tx.tx, { orgId, grant: issuedGrant, now });
    const first = await repo.applyJournal(tx.tx, { ...issue.journal, positionDeltas: issue.positionDeltas.map((delta) => ({ ...delta, asset: 'CREDIT', scale: 0 })) });
    tx.commit();
    expect(first.created).toBe(true);
    const before = store.position(issuedGrant.id, 'org-admin').balance_units;
    const duplicate = store.begin();
    await expect(repo.applyJournal(duplicate.tx, { ...issue.journal, positionDeltas: issue.positionDeltas.map((delta) => ({ ...delta, asset: 'CREDIT', scale: 0 })) }))
      .resolves.toMatchObject({ journalId: first.journalId, created: false });
    duplicate.commit();
    expect(store.position(issuedGrant.id, 'org-admin').balance_units).toBe(before);

    const changed = { ...issue.journal, entries: issue.journal.entries.map((line) => ({ ...line, amountUnits: line.amountUnits === '500' ? '499' : '-499' })) };
    const conflictTx = store.begin();
    await expect(repo.applyJournal(conflictTx.tx, { ...changed, positionDeltas: issue.positionDeltas.map((delta) => ({ ...delta, asset: 'CREDIT', scale: 0 })) }))
      .rejects.toMatchObject({ code: DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT });
    conflictTx.rollback();

    const rollbackStore = createTransactionalStore({ failOnceOn: /INSERT INTO billing_journal_lines/ });
    const rollbackRepo = createMysqlCreditRepository({ idSource: ids, clock: { now: () => now } });
    rollbackStore.state.grants.set(`${orgId}|${issuedGrant.id}`, { id: issuedGrant.id, org_id: orgId, asset: 'CREDIT', scale: 0,
      status: 'active', effective_at: issuedGrant.effectiveAt, expires_at: null });
    const failed = rollbackStore.begin();
    await expect(rollbackRepo.applyJournal(failed.tx, { ...issue.journal,
      positionDeltas: issue.positionDeltas.map((delta) => ({ ...delta, asset: 'CREDIT', scale: 0 })) })).rejects.toThrow('injected transactional write failure');
    failed.rollback();
    expect(rollbackStore.state.journals.size).toBe(0);
    expect(rollbackStore.state.lines).toHaveLength(0);
    expect(rollbackStore.position(issuedGrant.id, 'org-admin')).toBeUndefined();
  });
});

describe('credit account purpose migration contract', () => {
  test('adds purpose-scoped account uniqueness so organization pool and clearing accounts can coexist', () => {
    expect(accountPurposeMigration.id).toBe('2026100715_billing_credit_account_purpose');
    const sql = accountPurposeMigration.steps.map((step) => step.sql).join('\n');
    expect(sql).toMatch(/ADD COLUMN account_purpose VARCHAR\(32\) NOT NULL DEFAULT 'pool'/i);
    expect(sql).toContain('DROP INDEX uq_billing_credit_account_owner');
    expect(sql).toMatch(/UNIQUE KEY uq_billing_credit_account_owner_purpose\s*\(org_id,account_type,owner_id,account_purpose,asset,scale\)/i);
    expect(accountPurposeMigration.steps.some((step) => step.ignore?.includes('ER_DUP_FIELDNAME'))).toBe(true);
    expect(accountPurposeMigration.steps.some((step) => step.ignore?.includes('ER_DUP_KEYNAME'))).toBe(true);
  });
});
