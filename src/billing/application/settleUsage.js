'use strict';

const crypto = require('node:crypto');
const { validateAmount } = require('../kernel/amount');
const { validateUsageSettlement } = require('../contracts/commands');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../contracts/errors');
const { planConsume, planRelease } = require('../modules/credits/domain');
const { planFunding } = require('../modules/funding/planner');
const { workspaceScope } = require('../kernel/scope');

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function key(prefix, value) { return `${prefix}:${hash(value)}`; }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function childOperationId(parent, label) { return `settle-${hash(`${parent}\0${label}`).slice(0, 40)}`; }
function remaining(line) { return BigInt(line.heldUnits) - BigInt(line.consumedUnits) - BigInt(line.releasedUnits); }
function parsed(value) { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch (_) { return {}; } }

function createUsageSettlementService({
  unitOfWork, reservationRepository, settlementRepository, usageEventRepository, creditRepository,
  postpaidRepository, postpaidFundingSource, idSource, clock, authorizeSettlement, resolveFundingPolicy,
} = {}) {
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Usage settlement service requires UnitOfWork.runFinancial().');
  for (const [name, repo, methods] of [
    ['reservationRepository', reservationRepository, ['getBillingAccountForUpdate', 'getWorkspaceForUpdate', 'getWorkspaceCycleExposure', 'getForUpdate', 'listLinesForUpdate', 'updateReservation', 'markLineConsumed', 'adjustLineConsumed', 'markLineReleased', 'appendLines']],
    ['settlementRepository', settlementRepository, ['getPreviousRevision', 'getPriorRevisionIds', 'hasSettlement', 'getCreditChargesForEvents', 'getPostpaidChargesForEvents']],
    ['usageEventRepository', usageEventRepository, ['getById']],
    ['creditRepository', creditRepository, ['getGrantForUpdate', 'getPositionForUpdate', 'ensureAccount', 'applyJournal']],
    ['postpaidRepository', postpaidRepository, ['getWorkspacePolicyForUpdate', 'reserveExposure', 'settleReservedExposure', 'reverseSettledExposure', 'recordDebtJournal']],
  ]) for (const method of methods) if (typeof repo?.[method] !== 'function') throw new TypeError(`Usage settlement requires ${name}.${method}().`);
  if (!postpaidFundingSource || typeof postpaidFundingSource.supports !== 'function') throw new TypeError('Usage settlement requires a postpaid funding source adapter.');
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function' || typeof authorizeSettlement !== 'function' || typeof resolveFundingPolicy !== 'function') throw new TypeError('Usage settlement requires ID source, clock, authorization, and policy resolvers.');

  async function settlementPolicy(tx, { orgId, workspace, billingAccount, service, now }) {
    const resolvedValue = await resolveFundingPolicy({ tx, orgId, workspace, service, now, billingAccount });
    const resolved = resolvedValue && typeof resolvedValue === 'object' ? { ...resolvedValue } : null;
    if (!resolved || typeof resolved.serviceAllowed !== 'boolean') throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Funding policy resolver returned invalid settlement entitlement.');
    const configured = await postpaidRepository.getWorkspacePolicyForUpdate(tx, { orgId, workspaceId: workspace.id });
    resolved.postpaidPolicy = configured?.enabled ? { enabled: true, mode: configured.mode, cycleLimit: configured.cycleLimit, version: configured.version } : { enabled: false, mode: 'disabled', cycleLimit: null, version: configured?.version || 0 };
    resolved.allowedPostpaidModes = Array.isArray(resolved.allowedPostpaidModes) ? resolved.allowedPostpaidModes : [];
    resolved.postpaidEligible = resolved.postpaidEligible === true;
    resolved.postpaidPeriodId = resolved.postpaidPeriodId || resolved.cyclePeriodId || null;
    resolved.organizationExposureLimit = resolved.organizationExposureLimit || null;
    if (resolved.workspaceCycleCap) {
      const cap = validateAmount(resolved.workspaceCycleCap);
      if (!resolved.cyclePeriodId || !resolved.periodStartAt || !resolved.periodEndAt) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Workspace cycle cap requires an active period window during settlement.');
      const exposure = await reservationRepository.getWorkspaceCycleExposure(tx, { orgId, workspaceId: workspace.id,
        periodStart: resolved.periodStartAt, periodEnd: resolved.periodEndAt, asset: cap.asset, scale: cap.scale });
      resolved.workspaceCycleUsedUnits = exposure.usedUnits;
      resolved.workspaceCycleHeldUnits = exposure.heldUnits;
    }
    resolved.version = billingAccount.enforcementVersion;
    resolved.fallbackMode = billingAccount.fallbackMode;
    return resolved;
  }

  async function reversePrepaid(tx, { orgId, priorEventIds, correctionEventId, workspaceId, reservation, lines, actor, operationId, now, amountUnits }) {
    let left = amountUnits;
    const charges = await settlementRepository.getCreditChargesForEvents(tx, { orgId, eventIds: priorEventIds });
    const netBySource = new Map();
    for (const row of charges) {
      if (!['credit_consumption', 'usage_reversal'].includes(row.entry_type)) continue;
      const key = `${row.grant_id}:${row.account_id}`;
      const prior = netBySource.get(key) || { row, netUnits: 0n };
      if (row.entry_type === 'credit_consumption') prior.netUnits += -BigInt(row.amount_units);
      else prior.netUnits -= BigInt(row.amount_units);
      netBySource.set(key, prior);
    }
    for (const { row, netUnits } of netBySource.values()) {
      if (left <= 0n) break;
      if (netUnits <= 0n) continue;
      const units = netUnits < left ? netUnits : left;
      const grant = await creditRepository.getGrantForUpdate(tx, { orgId, grantId: row.grant_id });
      if (!grant) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Usage correction references a missing credit grant.');
      if (grant.status !== 'active' || (grant.expiresAt && Date.parse(now) >= Date.parse(grant.expiresAt))) { left -= units; continue; }
      const position = await creditRepository.getPositionForUpdate(tx, { orgId, grantId: row.grant_id, accountId: row.account_id });
      if (!position || position.scope?.ownerType !== 'workspace' || position.scope?.ownerId !== workspaceId) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Usage correction can only restore credits to the original workspace pool.');
      const amount = { asset: row.asset, units: units.toString(), scale: Number(row.scale) };
      const clearing = await creditRepository.ensureAccount(tx, { orgId, accountType: 'organization', ownerId: orgId, asset: amount.asset, scale: amount.scale, accountPurpose: 'usage_clearing', now });
      await creditRepository.applyJournal(tx, {
        orgId, operationId: childOperationId(operationId, `correction-credit:${correctionEventId}:${row.grant_id}`),
        operationType: 'credit_consume_reversal', sourceType: 'usage_event_revision', sourceId: correctionEventId,
        actorType: actor.type, actorId: actor.id, now, reason: `Reverse prior component usage for correction ${correctionEventId}`,
        entries: [
          { accountId: row.account_id, grantId: row.grant_id, amountUnits: units.toString(), asset: amount.asset, scale: amount.scale, entryType: 'usage_reversal' },
          { accountId: clearing.id, grantId: row.grant_id, amountUnits: (-units).toString(), asset: amount.asset, scale: amount.scale, entryType: 'usage_reversal_clearing' },
        ],
        positionDeltas: [{ accountId: row.account_id, grantId: row.grant_id, balanceDeltaUnits: units.toString(), reservedDeltaUnits: '0', asset: amount.asset, scale: amount.scale }],
      });
      const line = lines.find((item) => item.fundingSource !== 'postpaid' && item.grantId === row.grant_id && BigInt(item.consumedUnits) >= units);
      if (!line) throw new BillingDomainError(DOMAIN_ERROR_CODES.RESERVATION_STATE_CONFLICT, 'Usage correction exceeds the consumed reservation line amount.');
      await reservationRepository.adjustLineConsumed(tx, { orgId, line, deltaUnits: (-units).toString(), now });
      left -= units;
    }
    return left;
  }

  async function settle({ command, trustedContext } = {}) {
    const value = validateUsageSettlement(command, trustedContext);
    if (await authorizeSettlement({ actor: value.context.actor, orgId: value.orgId, workspaceId: value.workspaceId, action: 'usage.settle', usageEventId: value.usageEventId }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized to settle this workspace usage event.');
    const fingerprint = `sha256:${crypto.createHash('sha256').update(stable({ orgId: value.orgId, workspaceId: value.workspaceId, reservationId: value.reservationId, usageEventId: value.usageEventId, expectedVersion: value.expectedVersion, finalize: value.finalize })).digest('hex')}`;
    const now = clock.now();
    return unitOfWork.runFinancial({ orgId: value.orgId, operationId: value.context.operationId, requestFingerprint: fingerprint, expectedVersions: value.context.expectedVersions,
      callback: async (tx) => {
        const event = await usageEventRepository.getById(tx, { orgId: value.orgId, eventId: value.usageEventId });
        if (!event) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Priced usage event was not found.');
        if (event.status !== 'payable') throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Only payable, explicitly rated usage events can settle.');
        if (event.workspaceId !== value.workspaceId) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Usage event belongs to a different workspace.');
        const alreadySettled = await settlementRepository.hasSettlement(tx, { orgId: value.orgId, eventId: event.id });
        const reservation = await reservationRepository.getForUpdate(tx, { orgId: value.orgId, reservationId: value.reservationId });
        if (!reservation || reservation.workspaceId !== value.workspaceId) throw new BillingDomainError(DOMAIN_ERROR_CODES.RESERVATION_NOT_FOUND, 'Usage reservation was not found for this workspace.');
        if (reservation.version !== value.expectedVersion) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Usage reservation version is stale.', { details: { expectedVersion: value.expectedVersion, actualVersion: reservation.version } });
        if (event.operationId !== reservation.usageOperationId) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Usage event operation does not match the reservation.');
        const lines = await reservationRepository.listLinesForUpdate(tx, { orgId: value.orgId, reservationId: reservation.id });
        const prior = await settlementRepository.getPreviousRevision(tx, event);
        const priorEventIds = await settlementRepository.getPriorRevisionIds(tx, event);
        const priorSettled = prior && await settlementRepository.hasSettlement(tx, { orgId: value.orgId, eventId: prior.id });
        const priorAmount = priorSettled && prior.status === 'payable' ? BigInt(prior.amount.units) : 0n;
        const actual = BigInt(event.amount.units);
        if (event.amount.asset !== lines[0]?.amount.asset || event.amount.scale !== lines[0]?.amount.scale) throw new BillingDomainError(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Priced event amount must match reservation funding units.');
        let delta = alreadySettled ? 0n : actual - priorAmount;
        const billingAccount = await reservationRepository.getBillingAccountForUpdate(tx, { orgId: value.orgId });
        const workspace = await reservationRepository.getWorkspaceForUpdate(tx, { orgId: value.orgId, workspaceId: value.workspaceId });
        if (!workspace || String(workspace.status || '').toLowerCase() !== 'active') throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Usage settlement workspace is missing or inactive.');
        const request = reservation.fundingSnapshot?.request || {};
        const policy = await settlementPolicy(tx, { orgId: value.orgId, workspace, billingAccount, service: request.service, now });
        if (event.periodId) policy.postpaidPeriodId = event.periodId;
        let reversedUnits = 0n;
        if (delta < 0n && prior && !alreadySettled) {
          let reverseLeft = -delta;
          const correctionUnits = reverseLeft;
          reverseLeft = await reversePrepaid(tx, { orgId: value.orgId, priorEventIds, correctionEventId: event.id, workspaceId: value.workspaceId, reservation, lines, actor: value.context.actor, operationId: value.context.operationId, now, amountUnits: reverseLeft });
          reversedUnits += correctionUnits - reverseLeft;
          if (reverseLeft > 0n) {
            const postpaidRows = await settlementRepository.getPostpaidChargesForEvents(tx, { orgId: value.orgId, eventIds: priorEventIds });
            const exposureByPeriod = new Map();
            for (const charge of postpaidRows) {
              const key = `${charge.workspace_id}:${charge.period_id}:${charge.asset}:${charge.scale}`;
              const entry = exposureByPeriod.get(key) || { charge, netUnits: 0n, organizationLimitApplied: false };
              entry.netUnits += BigInt(charge.amount_units);
              entry.organizationLimitApplied ||= parsed(charge.metadata_json).organizationLimitApplied === true;
              exposureByPeriod.set(key, entry);
            }
            for (const { charge, netUnits, organizationLimitApplied } of exposureByPeriod.values()) {
              if (reverseLeft <= 0n || netUnits <= 0n) continue;
              const units = netUnits < reverseLeft ? netUnits : reverseLeft;
              const correctionAmount = { asset: charge.asset, units: units.toString(), scale: Number(charge.scale) };
              await postpaidRepository.reverseSettledExposure(tx, { orgId: value.orgId, workspaceId: charge.workspace_id, periodId: charge.period_id, amount: correctionAmount, organizationLimitApplied });
              await postpaidFundingSource.journal(tx, { orgId: value.orgId, workspaceId: charge.workspace_id, periodId: charge.period_id, reservationId: reservation.id,
                operationId: value.context.operationId, entryKey: key('usage-correction', `${event.id}\0${charge.period_id}`), entryType: 'usage_adjustment', amount: { ...correctionAmount, units: (-units).toString() },
                occurredAt: event.occurredAt, actorId: value.context.actor.id, reversalOfId: null, metadata: { eventId: event.id, priorEventId: prior.id, organizationLimitApplied, reason: 'late_usage_revision' } });
              reverseLeft -= units; reversedUnits += units;
            }
          }
          delta = 0n;
        }
        if (alreadySettled && !value.finalize) return Object.freeze({ eventId: event.id, duplicate: true, settledUnits: '0', reservationId: reservation.id });
        let left = delta > 0n ? delta : 0n;
        for (const line of lines) {
          if (!left) break;
          const available = remaining(line);
          if (available <= 0n) continue;
          const units = available < left ? available : left;
          const amount = { asset: event.amount.asset, units: units.toString(), scale: event.amount.scale };
          if (line.fundingSource === 'postpaid') {
            const applied = { orgId: value.orgId, workspaceId: value.workspaceId, periodId: line.periodId, amount,
              organizationLimitApplied: line.fundingSnapshot.organizationLimitApplied === true };
            await postpaidFundingSource.settle(tx, applied);
            await postpaidFundingSource.journal(tx, { ...applied, reservationId: reservation.id,
              operationId: value.context.operationId, entryKey: key('usage-charge', `${event.id}\0${line.id}`), entryType: 'usage_charge',
              occurredAt: event.occurredAt, actorId: value.context.actor.id,
              metadata: { eventId: event.id, usageOperationId: event.operationId, reservationLineId: line.id, organizationLimitApplied: applied.organizationLimitApplied, pricingSnapshot: event.pricingSnapshot } });
          } else {
            const grant = await creditRepository.getGrantForUpdate(tx, { orgId: value.orgId, grantId: line.grantId });
            const position = await creditRepository.getPositionForUpdate(tx, { orgId: value.orgId, grantId: line.grantId, accountId: line.accountId });
            const clearing = await creditRepository.ensureAccount(tx, { orgId: value.orgId, accountType: 'organization', ownerId: value.orgId, asset: amount.asset, scale: amount.scale, accountPurpose: 'usage_clearing', now });
            const plan = planConsume({ orgId: value.orgId, operationId: childOperationId(value.context.operationId, `usage:${event.id}:${line.id}`), grant,
              position: { ...position, balanceUnits: position.amount.units, status: position.accountStatus, accountPurpose: position.accountPurpose }, amount,
              reservationId: reservation.id, usageOccurredAt: event.occurredAt, usageClearingAccountId: clearing.id,
              actor: value.context.actor, now, reason: `Settle usage event ${event.id}` });
            await creditRepository.applyJournal(tx, { ...plan.journal, sourceType: 'usage_event', sourceId: event.id, positionDeltas: plan.positionDeltas });
          }
          await reservationRepository.markLineConsumed(tx, { orgId: value.orgId, line, amountUnits: units.toString(), now });
          left -= units;
        }
        if (left > 0n) {
          const validUntil = new Date(Date.parse(now) + 1000).toISOString();
          const overrunPlan = planFunding({ scope: workspaceScope(value.orgId, value.workspaceId), amount: { asset: event.amount.asset, units: left.toString(), scale: event.amount.scale }, positions: [], policy,
            now, validUntil });
          const overrun = overrunPlan.lines[0];
          if (!overrun || overrun.fundingSource !== 'postpaid') throw new BillingDomainError(DOMAIN_ERROR_CODES.INSUFFICIENT_CREDITS, 'Measured usage exceeds the reservation and no eligible postpaid limit can cover the overrun.', { details: { overrunUnits: left.toString() } });
          await postpaidFundingSource.reserve(tx, { orgId: value.orgId, workspaceId: value.workspaceId, periodId: overrun.periodId, amount: overrun.amount,
            workspaceLimit: policy.postpaidPolicy.mode === 'limited' ? policy.postpaidPolicy.cycleLimit : null, organizationLimit: policy.organizationExposureLimit });
          await postpaidFundingSource.settle(tx, { orgId: value.orgId, workspaceId: value.workspaceId, periodId: overrun.periodId, amount: overrun.amount, organizationLimitApplied: Boolean(policy.organizationExposureLimit) });
          const added = await reservationRepository.appendLines(tx, { orgId: value.orgId, reservationId: reservation.id, lines: [overrun], now });
          const line = added[added.length - 1];
          await reservationRepository.markLineConsumed(tx, { orgId: value.orgId, line, amountUnits: left.toString(), now });
          await postpaidFundingSource.journal(tx, { orgId: value.orgId, workspaceId: value.workspaceId, periodId: overrun.periodId, reservationId: reservation.id,
            operationId: value.context.operationId, entryKey: key('usage-overrun', event.id), entryType: 'usage_charge', amount: overrun.amount,
            occurredAt: event.occurredAt, actorId: value.context.actor.id, metadata: { eventId: event.id, overrun: true, organizationLimitApplied: Boolean(policy.organizationExposureLimit), pricingSnapshot: event.pricingSnapshot } });
          left = 0n;
        }
        let updated = reservation;
        if (value.finalize) {
          const latestLines = await reservationRepository.listLinesForUpdate(tx, { orgId: value.orgId, reservationId: reservation.id });
          for (const line of latestLines) {
            const unused = remaining(line);
            if (unused <= 0n) continue;
            const amount = { asset: line.amount.asset, units: unused.toString(), scale: line.amount.scale };
            if (line.fundingSource === 'postpaid') {
              await postpaidFundingSource.release(tx, { orgId: value.orgId, workspaceId: value.workspaceId, periodId: line.periodId, amount, organizationLimitApplied: line.fundingSnapshot.organizationLimitApplied === true });
            } else {
              const grant = await creditRepository.getGrantForUpdate(tx, { orgId: value.orgId, grantId: line.grantId });
              const position = await creditRepository.getPositionForUpdate(tx, { orgId: value.orgId, grantId: line.grantId, accountId: line.accountId });
              const expiry = grant.status === 'expired' || (grant.expiresAt && Date.parse(now) >= Date.parse(grant.expiresAt));
              const clearing = expiry ? await creditRepository.ensureAccount(tx, { orgId: value.orgId, accountType: 'organization', ownerId: value.orgId, asset: amount.asset, scale: amount.scale, accountPurpose: 'expiry_clearing', now }) : null;
              const plan = planRelease({ orgId: value.orgId, operationId: childOperationId(value.context.operationId, `final-release:${line.id}`), grant,
                position: { ...position, balanceUnits: position.amount.units, status: position.accountStatus, accountPurpose: position.accountPurpose }, amount,
                reservationId: reservation.id, expiryClearingAccountId: clearing?.id, actor: value.context.actor, now, reason: `Release unused usage hold ${reservation.id}` });
              if (plan.journal || plan.grantPatch) await creditRepository.applyJournal(tx, { ...plan.journal, operationId: plan.journal?.operationId || childOperationId(value.context.operationId, `expired-release:${line.id}`), positionDeltas: plan.positionDeltas, grantPatch: plan.grantPatch });
            }
            await reservationRepository.markLineReleased(tx, { orgId: value.orgId, line, now });
          }
          const latest = await reservationRepository.listLinesForUpdate(tx, { orgId: value.orgId, reservationId: reservation.id });
          const consumed = latest.some((line) => BigInt(line.consumedUnits) > 0n);
          updated = await reservationRepository.updateReservation(tx, { orgId: value.orgId, reservationId: reservation.id, expectedVersion: reservation.version,
            status: consumed ? 'settled' : 'released', validUntil: reservation.validUntil,
            fundingSnapshot: { ...reservation.fundingSnapshot, finalizedAt: now, finalUsageEventId: event.id }, closedAt: now, now });
        } else {
          updated = await reservationRepository.updateReservation(tx, { orgId: value.orgId, reservationId: reservation.id, expectedVersion: reservation.version,
            status: 'partially_consumed', validUntil: reservation.validUntil,
            fundingSnapshot: { ...reservation.fundingSnapshot, lastSettledUsageEventId: event.id }, now });
        }
        return Object.freeze({ eventId: event.id, duplicate: alreadySettled, settledUnits: alreadySettled ? '0' : actual.toString(), correctionUnits: reversedUnits.toString(), reservation: updated });
      },
    });
  }

  return Object.freeze({ settle });
}

module.exports = { createUsageSettlementService };
