'use strict';

const { createTransactionContext } = require('../../../src/billing/kernel/transactionContext');
const { createMysqlCreditRepository } = require('../../../src/billing/modules/credits/repositories/mysqlCreditRepository');

function fixture({ position, grantRow } = {}) {
  const calls = [];
  let sequence = 0;
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM billing_journals')) return { rows: [] };
    if (sql.includes('FROM billing_credit_accounts')) {
      return { rows: [{ id: params[1], asset: 'CREDIT', scale: 0, status: 'active', account_purpose: params[1] === 'clearing' ? 'funding_clearing' : 'pool' }] };
    }
    if (sql.includes('FROM billing_credit_grants')) {
      return { rows: [grantRow || { id: params[1], org_id: 'org-1', grant_kind: 'subscription', source_type: 'subscription_period',
        source_id: 'period-1', source_event_key: 'included-credits-v1', asset: 'CREDIT', amount_units: '100', scale: 0,
        status: 'active', effective_at: '2026-01-01T00:00:00Z', expires_at: new Date('2026-02-01T00:00:00.000Z') }] };
    }
    if (sql.includes('FROM billing_credit_positions')) return { rows: position ? [position] : [] };
    if (sql.startsWith('UPDATE')) return { rows: [], affectedRows: 1 };
    return { rows: [], affectedRows: 1 };
  });
  const tx = createTransactionContext({ query }, { orgId: 'org-1', operationId: 'op-1' });
  const repository = createMysqlCreditRepository({
    idSource: { newId: (kind) => `${kind}-${++sequence}` },
    clock: { now: () => '2026-01-02T00:00:00.000Z' },
  });
  return { repository, tx, calls, query };
}

describe('MySQL credit repository', () => {
  test('normalizes MySQL Date values on grant timestamps to ISO strings', async () => {
    const { repository, tx } = fixture({ grantRow: {
      id: 'grant-1', org_id: 'org-1', grant_kind: 'subscription', source_type: 'subscription_period',
      source_id: 'period-1', source_event_key: 'included-credits-v1', asset: 'CREDIT', amount_units: '100', scale: 0,
      status: 'active', effective_at: new Date('2026-01-01T00:00:00.000Z'), expires_at: new Date('2026-02-01T00:00:00.000Z'),
    } });

    await expect(repository.getGrantForUpdate(tx, { orgId: 'org-1', grantId: 'grant-1' })).resolves.toMatchObject({
      effectiveAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
    });
  });

  test('requires a branded transaction for mutations', async () => {
    const { repository } = fixture();
    await expect(repository.applyJournal({}, {})).rejects.toThrow('transaction context');
  });

  test('rejects unbalanced grant journal before writing', async () => {
    const { repository, tx, query } = fixture();
    await expect(repository.applyJournal(tx, {
      orgId: 'org-1', operationId: 'op-1', operationType: 'credit_transfer', now: '2026-01-02T00:00:00.000Z',
      entries: [
        { accountId: 'admin', grantId: 'grant-1', amountUnits: '10', asset: 'CREDIT', scale: 0, entryType: 'transfer_out' },
        { accountId: 'branch', grantId: 'grant-1', amountUnits: '-9', asset: 'CREDIT', scale: 0, entryType: 'transfer_in' },
      ],
    })).rejects.toMatchObject({ code: 'BILLING_INVALID_CONTRACT' });
    expect(query).not.toHaveBeenCalled();
  });

  test('writes balanced journal and applies only explicit position deltas', async () => {
    const { repository, tx, calls } = fixture();
    const result = await repository.applyJournal(tx, {
      orgId: 'org-1', operationId: 'op-1', operationType: 'credit_issue', sourceType: 'subscription', sourceId: 'period-1',
      actorType: 'system', now: '2026-01-02T00:00:00.000Z',
      entries: [
        { accountId: 'admin', grantId: 'grant-1', amountUnits: '50', asset: 'CREDIT', scale: 0, entryType: 'grant_issue' },
        { accountId: 'clearing', grantId: 'grant-1', amountUnits: '-50', asset: 'CREDIT', scale: 0, entryType: 'funding_clearing' },
      ],
      positionDeltas: [{ accountId: 'admin', grantId: 'grant-1', balanceDeltaUnits: '50', reservedDeltaUnits: '0' }],
    });
    expect(result).toMatchObject({ created: true, journalId: expect.any(String) });
    const positionWrite = calls.filter(({ sql }) => sql.includes('billing_credit_positions'));
    expect(positionWrite).toHaveLength(2); // locked read + single insert from positionDeltas
    expect(positionWrite[1].sql).toContain('INSERT INTO billing_credit_positions');
    expect(positionWrite[1].params).toContain('50');
    expect(calls.filter(({ sql }) => sql.includes('INSERT INTO billing_journal_lines'))).toHaveLength(2);
  });

  test('stores reservation-only changes atomically with a journal', async () => {
    const { repository, tx, calls } = fixture({ position: { id: 'pos-1', balance_units: '10', reserved_units: '0', version: 0 } });
    await repository.applyJournal(tx, {
      orgId: 'org-1', operationId: 'op-2', operationType: 'credit_reserve', now: '2026-01-02T00:00:00.000Z',
      entries: [
        { accountId: 'admin', grantId: 'grant-1', amountUnits: '5', asset: 'CREDIT', scale: 0, entryType: 'hold' },
        { accountId: 'admin', grantId: 'grant-1', amountUnits: '-5', asset: 'CREDIT', scale: 0, entryType: 'hold_offset' },
      ],
      positionDeltas: [{ accountId: 'admin', grantId: 'grant-1', reservedDeltaUnits: '5' }],
    });
    const positionWrite = calls.find(({ sql }) => sql.includes('UPDATE billing_credit_positions'));
    expect(positionWrite.params.slice(0, 2)).toEqual(['10', '5']);
  });
});
