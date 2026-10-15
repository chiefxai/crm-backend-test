'use strict';

const { createAutomaticCreditAllocationService, automaticAllocationsEnabled } = require('../../src/billing/automaticCreditAllocationService');

const activeWorkspace = { id: 'workspace-a', status: 'Active' };
const automaticTerms = { effectiveTerms: { structure: { mode: 'single', maxWorkspaces: 1 } } };
const multiTerms = { effectiveTerms: { structure: { mode: 'same_industry', maxWorkspaces: 5 } } };

function fixture({ terms = automaticTerms, workspaces = [activeWorkspace], position = { amount: { asset: 'CREDIT', units: '1200', scale: 0 }, reservedUnits: '200', version: 4 } } = {}) {
  const calls = [];
  const tx = { metadata: { orgId: 'org-a' }, query: async sql => {
    calls.push(sql);
    if (sql.includes('organization_billing_terms')) return { rows: [{ terms_snapshot_json: terms }] };
    if (sql.includes('FROM workspaces')) return { rows: workspaces };
    return { rows: [] };
  } };
  const grant = { id: 'grant-a', orgId: 'org-a', grantKind: 'subscription', status: 'active',
    amount: { asset: 'CREDIT', units: '1200', scale: 0 }, effectiveAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z' };
  const creditRepository = {
    getGrantForUpdate: jest.fn(async () => grant),
    ensureAccount: jest.fn(async (_tx, args) => ({ id: args.accountType === 'organization' ? 'pool-a' : 'workspace-pool-a' })),
    getPositionForUpdate: jest.fn(async (_tx, args) => ({ ...position, orgId: 'org-a', grantId: 'grant-a', accountId: args.accountId,
      amount: { ...position.amount, units: String(position.amount.units) }, reservedUnits: String(position.reservedUnits),
      scope: { orgId: 'org-a', ownerType: 'organization', ownerId: 'org-a' } })),
    applyJournal: jest.fn(async (_tx, journal) => { calls.push(journal); return { journalId: 'journal-a' }; }),
  };
  const service = createAutomaticCreditAllocationService({ creditRepository, clock: { now: () => '2026-01-15T00:00:00.000Z' } });
  return { service, creditRepository, calls, tx };
}

describe('automatic credit allocation service', () => {
  test('transfers only unheld grant units into the single active workspace through the ledger', async () => {
    const { service, creditRepository, calls, tx } = fixture();
    const result = await service.allocateCreditsAutomatically({ tx, orgId: 'org-a', grantId: 'grant-a', sourceEvent: 'renewal' });
    expect(result).toMatchObject({ status: 'partially_allocated', allocationMode: 'automatic', grantId: 'grant-a',
      workspaceId: 'workspace-a', amount: { asset: 'CREDIT', units: '1000', scale: 0 }, heldUnits:'200', journalId: 'journal-a' });
    expect(creditRepository.getPositionForUpdate).toHaveBeenCalledWith(tx, { orgId: 'org-a', grantId: 'grant-a', accountId: 'pool-a' });
    const journal = calls.find(item => item?.operationType === 'credit_transfer');
    expect(journal.entries.map(entry => entry.amountUnits)).toEqual(['-1000', '1000']);
    expect(journal.entries.every(entry => entry.grantId === 'grant-a')).toBe(true);
    expect(journal.actorType).toBe('system');
    expect(journal.actorId).toBe('automatic-credit-allocation');
  });

  test('keeps multi-workspace subscriptions manual and performs no transfer', async () => {
    const { service, creditRepository, tx } = fixture({ terms: multiTerms });
    await expect(service.allocateCreditsAutomatically({ tx, orgId: 'org-a', grantId: 'grant-a' }))
      .resolves.toMatchObject({ status: 'not_applicable', allocationMode: 'manual' });
    expect(creditRepository.applyJournal).not.toHaveBeenCalled();
  });

  test('does not guess a destination when single-workspace inventory is not ready', async () => {
    const { service, creditRepository, tx } = fixture({ workspaces: [activeWorkspace, { id: 'workspace-b', status: 'Inactive' }] });
    await expect(service.allocateCreditsAutomatically({ tx, orgId: 'org-a', grantId: 'grant-a' }))
      .rejects.toThrow(/exactly one active workspace/);
    expect(creditRepository.getGrantForUpdate).not.toHaveBeenCalled();
    expect(creditRepository.applyJournal).not.toHaveBeenCalled();
  });

  test('does not transfer held units or mint on an empty position', async () => {
    const { service, creditRepository, tx } = fixture({ position: { amount: { asset: 'CREDIT', units: '100', scale: 0 }, reservedUnits: '100', version: 1 } });
    await expect(service.allocateCreditsAutomatically({ tx, orgId: 'org-a', grantId: 'grant-a' }))
      .resolves.toMatchObject({ status: 'nothing_to_transfer' });
    expect(creditRepository.applyJournal).not.toHaveBeenCalled();
  });

  test('automatic financial transfers remain disabled unless explicitly opted in', () => {
    expect(automaticAllocationsEnabled('org-a', {})).toBe(false);
    expect(automaticAllocationsEnabled('org-a', { BILLING_AUTOMATIC_ALLOCATION_ENABLED: 'true' })).toBe(false);
    expect(automaticAllocationsEnabled('org-a', { BILLING_AUTOMATIC_ALLOCATION_ENABLED: 'true',
      BILLING_AUTOMATIC_ALLOCATION_ORG_IDS:'org-b, org-a' })).toBe(true);
    expect(automaticAllocationsEnabled('org-c', { BILLING_AUTOMATIC_ALLOCATION_ENABLED: 'true',
      BILLING_AUTOMATIC_ALLOCATION_ORG_IDS:'org-b, org-a' })).toBe(false);
  });
});
