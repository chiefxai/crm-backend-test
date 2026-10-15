'use strict';

const crypto = require('node:crypto');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('./contracts/errors');
const { organizationScope, workspaceScope, validateId } = require('./kernel/scope');
const { planTransfer } = require('./modules/credits/domain');
const { resolveAllocationMode } = require('./allocationModeResolver');

function rowsOf(value) {
  const result = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(result) ? result : result?.rows || [];
}
function stableOperationId(orgId, grantId) {
  const key = crypto.createHash('sha256').update(`${orgId}\0${grantId}\0single-workspace-auto-allocation-v1`).digest('hex');
  return `auto-credit-transfer-${key.slice(0, 40)}`;
}
function automaticAllocationsEnabled(orgId, env = process.env) {
  if (env.BILLING_AUTOMATIC_ALLOCATION_ENABLED !== 'true' || typeof orgId !== 'string' || !orgId) return false;
  const allowedOrganizations = new Set(String(env.BILLING_AUTOMATIC_ALLOCATION_ORG_IDS || '')
    .split(',').map(value => value.trim()).filter(Boolean));
  return allowedOrganizations.has(orgId);
}

function previewAutomaticAllocationReconciliation(snapshot) {
  const allocation = snapshot?.allocation;
  if (allocation?.allocationMode !== 'automatic' && allocation?.mode !== 'automatic') {
    return Object.freeze({ status: 'not_applicable', allocationMode: allocation?.allocationMode || allocation?.mode || 'unknown',
      workspaceId: null, transfers: [], skipped: [] });
  }
  if (allocation.status !== 'ready' || !allocation.workspaceId) {
    return Object.freeze({ status: 'review_required', allocationMode: 'automatic',
      workspaceId: allocation.workspaceId || null, transfers: [], skipped: [{ reason: allocation.status || 'not_ready' }] });
  }
  const transfers = [];
  const skipped = [];
  for (const grant of snapshot.grants || []) {
    const units = String(grant.available?.units ?? '0');
    if (!/^(0|[1-9][0-9]*)$/.test(units)) throw new TypeError('Reconciliation grant amount must use non-negative integer units.');
    if (BigInt(units) === 0n) {
      skipped.push({ grantId: grant.id, reason: 'no_unreserved_balance' });
      continue;
    }
    transfers.push(Object.freeze({ grantId: grant.id, grantKind: grant.kind,
      amount: grant.available, held: grant.held, expiresAt: grant.expiresAt,
      expectedPositionVersion: grant.positionVersion, workspaceId: allocation.workspaceId }));
  }
  return Object.freeze({ status: transfers.length ? 'dry_run_ready' : 'nothing_to_reconcile',
    allocationMode: 'automatic', workspaceId: allocation.workspaceId,
    transfers: Object.freeze(transfers), skipped: Object.freeze(skipped) });
}

function createAutomaticCreditAllocationService({ creditRepository, clock } = {}) {
  for (const method of ['ensureAccount', 'getGrantForUpdate', 'getPositionForUpdate', 'applyJournal']) {
    if (typeof creditRepository?.[method] !== 'function') throw new TypeError(`Automatic allocation requires credit repository ${method}().`);
  }
  if (typeof clock?.now !== 'function') throw new TypeError('Automatic allocation requires a clock.');

  async function allocateCreditsAutomatically({ tx, orgId, grantId, termsSnapshot, sourceEvent = 'credit-grant', now = clock.now() } = {}) {
    validateId(orgId, 'orgId');
    validateId(grantId, 'grantId');
    if (!tx || typeof tx.query !== 'function' || tx.metadata?.orgId !== orgId) {
      throw new TypeError('Automatic allocation requires a transaction scoped to the organization.');
    }
    const termSnapshot = termsSnapshot ?? rowsOf(await tx.query(`SELECT terms_snapshot_json FROM organization_billing_terms
      WHERE org_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)
      ORDER BY effective_from DESC,version DESC LIMIT 1`, [orgId, now, now]))[0]?.terms_snapshot_json;
    const parsedTerms = typeof termSnapshot === 'string' ? JSON.parse(termSnapshot) : termSnapshot;
    const workspaces = rowsOf(await tx.query(
      'SELECT id,status FROM workspaces WHERE org_id=? ORDER BY id FOR UPDATE', [orgId],
    ));
    const capability = resolveAllocationMode({ termsSnapshot: parsedTerms, workspaces });
    if (capability.allocationMode === 'manual') {
      return Object.freeze({ status: 'not_applicable', allocationMode: 'manual', grantId });
    }
    if (capability.allocationMode !== 'automatic' || capability.status !== 'ready' || !capability.workspaceId) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.AUTOMATIC_ALLOCATION_NOT_READY,
        'Automatic allocation requires validated single-workspace terms and exactly one active workspace.',
        { details: { allocationMode: capability.allocationMode, status: capability.status } });
    }

    const grant = await creditRepository.getGrantForUpdate(tx, { orgId, grantId });
    if (!grant) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Credit grant was not found for this organization.');
    if (grant.orgId !== orgId || !['subscription', 'topup'].includes(grant.grantKind)) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Automatic allocation requires an organization subscription or top-up grant.');
    }
    const fromScope = organizationScope(orgId);
    const toScope = workspaceScope(orgId, capability.workspaceId);
    const accountArgs = { orgId, asset: grant.amount.asset, scale: grant.amount.scale, now };
    const sourceAccount = await creditRepository.ensureAccount(tx, {
      ...accountArgs, accountType: 'organization', ownerId: orgId, accountPurpose: 'pool',
    });
    const targetAccount = await creditRepository.ensureAccount(tx, {
      ...accountArgs, accountType: 'workspace', ownerId: capability.workspaceId,
      workspaceId: capability.workspaceId, accountPurpose: 'pool',
    });
    if (sourceAccount.id === targetAccount.id) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE,
      'Automatic allocation source and destination accounts must be distinct.', { retryable: true });
    const position = await creditRepository.getPositionForUpdate(tx, { orgId, grantId, accountId: sourceAccount.id });
    if (!position) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Organization pool has no position for this credit grant.');
    const available = BigInt(position.balanceUnits) - BigInt(position.reservedUnits);
    if (available < 0n) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Credit grant position has an invalid held balance.', { retryable: true });
    if (available === 0n) return Object.freeze({ status: 'nothing_to_transfer', allocationMode: 'automatic', grantId, workspaceId: capability.workspaceId,
      heldUnits: String(position.reservedUnits) });

    const amount = { asset: grant.amount.asset, scale: grant.amount.scale, units: available.toString() };
    const operationId = stableOperationId(orgId, grantId);
    const plan = planTransfer({
      orgId, operationId, grant,
      from: { ...position, accountId: sourceAccount.id, scope: fromScope },
      to: { id: targetAccount.id, scope: toScope },
      fromScope, toScope, amount,
      actor: { type: 'system', id: 'automatic-credit-allocation' }, now,
      reason: `Automatic ${grant.grantKind} allocation (${sourceEvent})`,
    });
    const journal = await creditRepository.applyJournal(tx, { ...plan.journal, positionDeltas: plan.positionDeltas });
    return Object.freeze({ status: available < BigInt(position.balanceUnits) ? 'partially_allocated' : 'allocated',
      allocationMode: 'automatic', grantId, workspaceId: capability.workspaceId, amount,
      heldUnits: String(position.reservedUnits), journalId: journal.journalId, operationId });
  }

  return Object.freeze({ allocateCreditsAutomatically });
}

module.exports = { createAutomaticCreditAllocationService, stableOperationId,
  automaticAllocationsEnabled, previewAutomaticAllocationReconciliation };
