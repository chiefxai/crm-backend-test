'use strict';

const crypto = require('node:crypto');
const { validateAllocationRuleSet, validateAllocationRun, validateAllocationRunOperation, validateCreditTransfer } = require('../../contracts/commands');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');
const { organizationScope, workspaceScope, validateId } = require('../../kernel/scope');
const { planTransfer } = require('../credits/domain');
const { previewAllocation, normalizeRules } = require('./domain');

const DEFAULT_ATOMIC_LIMIT = 25;
const DEFAULT_BATCH_LIMIT = 25;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`; }
function isActive(workspace) { return ['active', 'enabled'].includes(String(workspace?.status || '').toLowerCase()); }
function availableAccountArgs(orgId, scope, amount, accountPurpose = 'pool') {
  return scope.ownerType === 'organization'
    ? { orgId, accountType: 'organization', ownerId: orgId, asset: amount.asset, scale: amount.scale, accountPurpose }
    : { orgId, accountType: 'workspace', ownerId: scope.ownerId, workspaceId: scope.ownerId, asset: amount.asset, scale: amount.scale, accountPurpose };
}

function createAllocationService({
  unitOfWork, allocationRepository, creditRepository, idSource, clock, authorizeAllocation,
  atomicLimit = DEFAULT_ATOMIC_LIMIT, batchLimit = DEFAULT_BATCH_LIMIT,
} = {}) {
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Allocation service requires the billing UnitOfWork.');
  for (const method of ['getWorkspaces', 'getWorkspace', 'getRuleVersion', 'saveRuleVersion', 'getRunForUpdate', 'getAutomaticRunForGrant', 'createRun', 'updateRun']) {
    if (typeof allocationRepository?.[method] !== 'function') throw new TypeError(`Allocation repository requires ${method}().`);
  }
  for (const method of ['ensureAccount', 'getGrantForUpdate', 'getPositionForUpdate', 'applyJournal']) {
    if (typeof creditRepository?.[method] !== 'function') throw new TypeError(`Credit repository requires ${method}() for allocation.`);
  }
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Allocation service requires an ID source and clock.');
  if (typeof authorizeAllocation !== 'function') throw new TypeError('Allocation service requires organization-admin authorization.');
  if (!Number.isInteger(atomicLimit) || atomicLimit < 1 || atomicLimit > 100) throw new TypeError('atomicLimit must be from 1 to 100.');
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) throw new TypeError('batchLimit must be from 1 to 100.');

  function assertGrant(grant, orgId, grantKind) {
    if (!grant) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Credit grant was not found for this organization.');
    if (grant.orgId !== orgId) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Credit grant belongs to another organization.');
    if (grant.grantKind !== grantKind) throw new BillingDomainError(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Allocation grant kind does not match the selected rule set.');
    return grant;
  }

  async function account(tx, orgId, scope, amount, purpose = 'pool') {
    return creditRepository.ensureAccount(tx, { ...availableAccountArgs(orgId, scope, amount, purpose), now: clock.now() });
  }

  async function applyTransfer(tx, { orgId, grant, fromAccount, fromPosition, fromScope, toAccount, toScope, amountUnits, operationId, actor, reason, allowSameScope = false, allowExpiredReturn = false, now }) {
    if (!fromPosition) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Source account has no position for this grant.');
    if (fromPosition.accountStatus && fromPosition.accountStatus !== 'active') throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Source credit account is not active.');
    const amount = { asset: grant.amount.asset, units: String(amountUnits), scale: grant.amount.scale };
    const plan = planTransfer({
      orgId, operationId, grant,
      from: { ...fromPosition, accountId: fromAccount.id, scope: fromScope },
      to: { id: toAccount.id, scope: toScope },
      fromScope, toScope, amount, actor, now, reason, allowSameScope, allowExpiredReturn,
    });
    return creditRepository.applyJournal(tx, { ...plan.journal, positionDeltas: plan.positionDeltas });
  }

  async function allocateGrantInTransaction(tx, command, actor, operationId) {
    const grant = assertGrant(await creditRepository.getGrantForUpdate(tx, { orgId: command.orgId, grantId: command.grantId }), command.orgId, command.grantKind);
    if (command.periodId && grant.periodId !== command.periodId) throw new BillingDomainError(DOMAIN_ERROR_CODES.ALLOCATION_INVALID, 'Grant does not belong to the selected period.');
    const ruleVersion = await allocationRepository.getRuleVersion(tx, {
      orgId: command.orgId, grantKind: command.grantKind, version: command.ruleVersion,
    });
    if (!ruleVersion) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'No effective allocation rules exist for this grant kind.');
    const prior = await allocationRepository.getAutomaticRunForGrant(tx, { orgId: command.orgId, grantId: grant.id });
    if (prior) {
      if (prior.ruleVersionId !== ruleVersion.id) throw new BillingDomainError(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Allocation run key is already used by a different rule version.');
      return prior;
    }
    const adminScope = organizationScope(command.orgId);
    const adminAccount = await account(tx, command.orgId, adminScope, grant.amount);
    const adminPosition = await creditRepository.getPositionForUpdate(tx, { orgId: command.orgId, grantId: grant.id, accountId: adminAccount.id });
    if (!adminPosition) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Admin pool has no position for this grant.');
    const workspaceIds = ruleVersion.rules.map((rule) => rule.workspaceId);
    const workspaces = await allocationRepository.getWorkspaces(tx, { orgId: command.orgId, workspaceIds });
    const preview = previewAllocation({ grant, adminPosition, rules: ruleVersion.rules, workspaces });
    const now = clock.now();
    const zeroOrSkipped = preview.allocations.filter((entry) => entry.status !== 'planned');
    const recipients = preview.allocations.filter((entry) => entry.status === 'planned');
    const manifestBase = {
      schemaVersion: 1, grantId: grant.id, grantKind: grant.grantKind,
      grantAmount: grant.amount, ruleVersionId: ruleVersion.id, ruleVersion: ruleVersion.version,
      sourcePeriodId: command.periodId || grant.periodId || null,
      entries: [
        ...zeroOrSkipped.map((entry) => ({ ...entry })),
        ...recipients.map((entry) => ({ ...entry, status: recipients.length > atomicLimit ? 'pending' : 'planned' })),
      ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    };
    const totalUnits = preview.totalUnits;

    if (recipients.length > atomicLimit && BigInt(totalUnits) > 0n) {
      const clearingAccount = await account(tx, command.orgId, adminScope, grant.amount, 'allocation_clearing');
      await applyTransfer(tx, {
        orgId: command.orgId, grant, fromAccount: adminAccount, fromPosition: adminPosition, fromScope: adminScope,
        toAccount: clearingAccount, toScope: adminScope, amountUnits: totalUnits,
        operationId: `${operationId}:escrow`, actor, reason: `Hold allocation run ${command.runKey}`,
        allowSameScope: true, now,
      });
      return allocationRepository.createRun(tx, {
        orgId: command.orgId, grantId: grant.id, periodId: command.periodId || grant.periodId || null,
        ruleVersionId: ruleVersion.id, runKey: command.runKey, runType: 'automatic', status: 'pending',
        manifest: manifestBase, totalUnits, appliedUnits: '0', now,
      });
    }

    let manifest = manifestBase;
    let applied = 0n;
    for (let index = 0; index < recipients.length; index += 1) {
      const target = recipients[index];
      const targetScope = workspaceScope(command.orgId, target.workspaceId);
      const targetAccount = await account(tx, command.orgId, targetScope, grant.amount);
      const source = await creditRepository.getPositionForUpdate(tx, { orgId: command.orgId, grantId: grant.id, accountId: adminAccount.id });
      const result = await applyTransfer(tx, {
        orgId: command.orgId, grant, fromAccount: adminAccount, fromPosition: source, fromScope: adminScope,
        toAccount: targetAccount, toScope: targetScope, amountUnits: target.units,
        operationId: `${operationId}:allocation:${index}`, actor, reason: `Apply ${command.grantKind} workspace allocation`, now,
      });
      applied += BigInt(target.units);
      manifest = updateManifestEntry(manifest, target.workspaceId, { status: 'applied', journalId: result.journalId });
    }
    for (const entry of zeroOrSkipped) {
      if (entry.status === 'skipped_suspended') continue;
      manifest = updateManifestEntry(manifest, entry.workspaceId, { status: 'zero' });
    }
    return allocationRepository.createRun(tx, {
      orgId: command.orgId, grantId: grant.id, periodId: command.periodId || grant.periodId || null,
      ruleVersionId: ruleVersion.id, runKey: command.runKey, runType: 'automatic', status: 'completed',
      manifest, totalUnits, appliedUnits: applied.toString(), completedAt: now, now,
    });
  }

  function updateManifestEntry(manifest, workspaceId, patch) {
    return { ...manifest, entries: manifest.entries.map((entry) => entry.workspaceId === workspaceId ? { ...entry, ...patch } : entry) };
  }

  async function settlePending(tx, run, { orgId, actor, operationId, now, cancel = false }) {
    const grant = await creditRepository.getGrantForUpdate(tx, { orgId, grantId: run.grantId });
    if (!grant) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Allocation run grant was not found.');
    const adminScope = organizationScope(orgId);
    const adminAccount = await account(tx, orgId, adminScope, grant.amount);
    const clearingAccount = await account(tx, orgId, adminScope, grant.amount, 'allocation_clearing');
    const pending = run.manifest.entries.filter((entry) => entry.status === 'pending');
    const nowExpired = grant.status === 'expired' || (grant.expiresAt && Date.parse(now) >= Date.parse(grant.expiresAt));
    const expiryAccount = nowExpired
      ? await account(tx, orgId, adminScope, grant.amount, 'expiry_clearing')
      : adminAccount;
    const settle = cancel || nowExpired ? pending : pending.slice(0, batchLimit);
    let applied = BigInt(run.appliedUnits);
    let manifest = run.manifest;
    for (let index = 0; index < settle.length; index += 1) {
      const entry = settle[index];
      const workspace = await allocationRepository.getWorkspace(tx, { orgId, workspaceId: entry.workspaceId });
      if (!workspace) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Allocation workspace no longer exists.', { details: { workspaceId: entry.workspaceId } });
      const giveToWorkspace = !cancel && !nowExpired && isActive(workspace);
      const targetScope = giveToWorkspace ? workspaceScope(orgId, entry.workspaceId) : adminScope;
      const targetAccount = giveToWorkspace ? await account(tx, orgId, targetScope, grant.amount) : expiryAccount;
      const source = await creditRepository.getPositionForUpdate(tx, { orgId, grantId: grant.id, accountId: clearingAccount.id });
      const result = await applyTransfer(tx, {
        orgId, grant, fromAccount: clearingAccount, fromPosition: source, fromScope: adminScope,
        toAccount: targetAccount, toScope: targetScope, amountUnits: entry.units,
        operationId: `${operationId}:entry:${index}`, actor,
        reason: giveToWorkspace ? `Deliver allocation run ${run.runKey}` : `Return undistributed allocation run ${run.runKey}`,
        allowSameScope: targetScope.ownerType === 'organization', allowExpiredReturn: !giveToWorkspace, now,
      });
      if (giveToWorkspace) applied += BigInt(entry.units);
      manifest = updateManifestEntry(manifest, entry.workspaceId, {
        status: giveToWorkspace ? 'applied' : (nowExpired ? 'returned_to_expiry_clearing' : (cancel ? 'cancelled_returned' : 'skipped_suspended')),
        journalId: result.journalId,
      });
    }
    const stillPending = manifest.entries.some((entry) => entry.status === 'pending');
    const status = cancel ? 'cancelled' : (stillPending ? 'pending' : 'completed');
    return allocationRepository.updateRun(tx, {
      orgId, runId: run.id, expectedVersion: run.version, status, manifest,
      totalUnits: run.totalUnits, appliedUnits: applied.toString(),
      completedAt: status === 'pending' ? null : now, now,
    });
  }

  return Object.freeze({
    preview({ grant, adminPosition, rules, workspaces }) { return previewAllocation({ grant, adminPosition, rules, workspaces }); },

    async saveRules({ command, trustedContext } = {}) {
      const value = validateAllocationRuleSet(command, trustedContext);
      if (await authorizeAllocation({ actor: value.context.actor, orgId: value.orgId, action: 'allocation_rules.write' }) !== true) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to manage organization allocation rules.');
      }
      const rules = normalizeRules(value.rules, value.grantKind);
      const requestFingerprint = fingerprint({ orgId: value.orgId, grantKind: value.grantKind, ruleVersion: value.ruleVersion, expectedVersion: value.expectedVersion, rules, actorId: value.context.actor.id });
      const now = clock.now();
      return unitOfWork.runFinancial({
        orgId: value.orgId, operationId: value.context.operationId, requestFingerprint,
        expectedVersions: value.context.expectedVersions,
        callback: async (tx) => {
          await allocationRepository.getWorkspaces(tx, { orgId: value.orgId, workspaceIds: rules.map((rule) => rule.workspaceId) });
          return allocationRepository.saveRuleVersion(tx, {
            orgId: value.orgId, grantKind: value.grantKind, version: value.ruleVersion,
            expectedVersion: value.expectedVersion, rules, actorId: value.context.actor.id, now,
          });
        },
      });
    },

    async transfer({ command, trustedContext } = {}) {
      const value = validateCreditTransfer(command, trustedContext);
      if (await authorizeAllocation({ actor: value.context.actor, orgId: value.orgId, action: 'credits.transfer', fromScope: value.fromScope, toScope: value.toScope }) !== true) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to transfer organization credits.');
      }
      const requestFingerprint = fingerprint({ orgId: value.orgId, grantId: value.grantId, fromScope: value.fromScope, toScope: value.toScope, amount: value.amount, expectedPositionVersion: value.expectedPositionVersion, actorId: value.context.actor.id });
      const now = clock.now();
      return unitOfWork.runFinancial({
        orgId: value.orgId, operationId: value.context.operationId, requestFingerprint,
        expectedVersions: value.context.expectedVersions,
        callback: async (tx) => {
          const grant = await creditRepository.getGrantForUpdate(tx, { orgId: value.orgId, grantId: value.grantId });
          if (!grant) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Credit grant was not found.');
          if (value.toScope.ownerType === 'workspace') {
            const workspace = await allocationRepository.getWorkspace(tx, { orgId: value.orgId, workspaceId: value.toScope.ownerId });
            if (!workspace) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Target workspace was not found in this organization.');
            if (!isActive(workspace)) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Credits cannot be transferred to a suspended workspace.');
          }
          const fromAccount = await account(tx, value.orgId, value.fromScope, grant.amount);
          const toAccount = await account(tx, value.orgId, value.toScope, grant.amount);
          const fromPosition = await creditRepository.getPositionForUpdate(tx, { orgId: value.orgId, grantId: grant.id, accountId: fromAccount.id });
          if (!fromPosition) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Source account has no position for this grant.');
          if (fromPosition.version !== value.expectedPositionVersion) {
            throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Source credit position changed concurrently.', { details: { expectedVersion: value.expectedPositionVersion, actualVersion: fromPosition.version } });
          }
          const plan = planTransfer({
            orgId: value.orgId, operationId: value.context.operationId, grant,
            from: { ...fromPosition, accountId: fromAccount.id, scope: value.fromScope },
            to: { id: toAccount.id, scope: value.toScope },
            fromScope: value.fromScope, toScope: value.toScope, amount: value.amount,
            actor: value.context.actor, now, reason: 'Administrative workspace credit transfer',
          });
          const journal = await creditRepository.applyJournal(tx, { ...plan.journal, positionDeltas: plan.positionDeltas });
          return Object.freeze({ grantId: grant.id, fromScope: value.fromScope, toScope: value.toScope, amount: value.amount, journalId: journal.journalId });
        },
      });
    },

    async runRules({ command, trustedContext } = {}) {
      const value = validateAllocationRun(command, trustedContext);
      if (await authorizeAllocation({ actor: value.context.actor, orgId: value.orgId, action: 'allocation.run', grantId: value.grantId }) !== true) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to allocate organization credits.');
      }
      const requestFingerprint = fingerprint({ orgId: value.orgId, grantId: value.grantId, grantKind: value.grantKind, runKey: value.runKey, ruleVersion: value.ruleVersion || null, periodId: value.periodId || null, actorId: value.context.actor.id });
      return unitOfWork.runFinancial({
        orgId: value.orgId, operationId: value.context.operationId, requestFingerprint,
        expectedVersions: value.context.expectedVersions,
        callback: (tx) => allocateGrantInTransaction(tx, value, value.context.actor, value.context.operationId),
      });
    },

    async processRun({ command, trustedContext } = {}) {
      const value = validateAllocationRunOperation(command, trustedContext);
      if (await authorizeAllocation({ actor: value.context.actor, orgId: value.orgId, action: 'allocation.run', runId: value.runId }) !== true) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to process allocation runs.');
      }
      const requestFingerprint = fingerprint({ orgId: value.orgId, runId: value.runId, expectedVersion: value.expectedVersion ?? null, actorId: value.context.actor.id, action: 'process' });
      const now = clock.now();
      return unitOfWork.runFinancial({
        orgId: value.orgId, operationId: value.context.operationId, requestFingerprint, expectedVersions: value.context.expectedVersions,
        callback: async (tx) => {
          const run = await allocationRepository.getRunForUpdate(tx, { orgId: value.orgId, runId: value.runId });
          if (!run) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Allocation run was not found.');
          if (value.expectedVersion !== undefined && value.expectedVersion !== run.version) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Allocation run version is stale.', { details: { expectedVersion: value.expectedVersion, actualVersion: run.version } });
          if (run.status === 'completed' || run.status === 'cancelled') return run;
          return settlePending(tx, run, { orgId: value.orgId, actor: value.context.actor, operationId: value.context.operationId, now });
        },
      });
    },

    async cancelRun({ command, trustedContext } = {}) {
      const value = validateAllocationRunOperation(command, trustedContext);
      if (await authorizeAllocation({ actor: value.context.actor, orgId: value.orgId, action: 'allocation.run', runId: value.runId }) !== true) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to cancel allocation runs.');
      }
      const requestFingerprint = fingerprint({ orgId: value.orgId, runId: value.runId, expectedVersion: value.expectedVersion ?? null, actorId: value.context.actor.id, action: 'cancel' });
      const now = clock.now();
      return unitOfWork.runFinancial({
        orgId: value.orgId, operationId: value.context.operationId, requestFingerprint, expectedVersions: value.context.expectedVersions,
        callback: async (tx) => {
          const run = await allocationRepository.getRunForUpdate(tx, { orgId: value.orgId, runId: value.runId });
          if (!run) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Allocation run was not found.');
          if (value.expectedVersion !== undefined && value.expectedVersion !== run.version) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Allocation run version is stale.');
          if (run.status === 'cancelled') return run;
          if (run.status === 'completed') throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Completed allocation runs cannot be cancelled.');
          return settlePending(tx, run, { orgId: value.orgId, actor: value.context.actor, operationId: value.context.operationId, now, cancel: true });
        },
      });
    },
  });
}

module.exports = { createAllocationService, DEFAULT_ATOMIC_LIMIT, DEFAULT_BATCH_LIMIT, fingerprint };
