'use strict';

const crypto = require('node:crypto');
const { validateAmount } = require('../kernel/amount');
const { workspaceScope } = require('../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../contracts/errors');
const {
  validateUsageFundingRequest,
  validateUsageReservationExtension,
  validateUsageReservationRelease,
} = require('../contracts/commands');
const { planReserve, planRelease } = require('../modules/credits/domain');
const { planFunding } = require('../modules/funding/planner');
const { createPostpaidFundingSource } = require('../modules/postpaid/fundingSource');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`; }
function childOperationId(parent, label) {
  return `fund-${crypto.createHash('sha256').update(`${parent}\0${label}`).digest('hex').slice(0, 40)}`;
}
function instant(value, field) {
  const date = value instanceof Date ? value : new Date(/Z$|[+-]\d\d:\d\d$/.test(String(value)) ? value : `${String(value).replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime())) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, `${field} must be a valid timestamp.`);
  return date.toISOString();
}
function asGrant(value) {
  if (!value) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Credit grant was not found.');
  return { ...value, effectiveAt: instant(value.effectiveAt, 'grant.effectiveAt'), expiresAt: value.expiresAt == null ? null : instant(value.expiresAt, 'grant.expiresAt') };
}
function emptyRemaining(line) { return BigInt(line.heldUnits) - BigInt(line.consumedUnits) - BigInt(line.releasedUnits); }
function requestSnapshot(value) {
  return {
    service: value.service,
    estimatedAmount: value.estimatedAmount,
    pricingSnapshot: value.pricingSnapshot,
    validUntil: value.validUntil,
    policyVersion: value.policyVersion,
    sourceRevision: value.sourceRevision || '0',
  };
}
function objectSnapshot(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

/**
 * Atomic prepaid/postpaid reservation service. Provider calls remain outside this
 * service; all holds and reservation rows commit in one organization UoW.
 */
function createUsageReservationService({
  unitOfWork, reservationRepository, creditRepository, postpaidRepository, idSource, clock,
  authorizeUsage, resolveFundingPolicy,
} = {}) {
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Usage reservation service requires UnitOfWork.runFinancial().');
  for (const method of ['getWorkspaceForUpdate', 'getBillingAccountForUpdate', 'listWorkspacePositionsForUpdate', 'getByUsageKey', 'getForUpdate', 'listLinesForUpdate', 'createReservation', 'appendLines', 'updateReservation', 'markLineReleased', 'getWorkspaceCycleExposure']) {
    if (typeof reservationRepository?.[method] !== 'function') throw new TypeError(`Usage reservation repository requires ${method}().`);
  }
  for (const method of ['getGrantForUpdate', 'getPositionForUpdate', 'ensureAccount', 'applyJournal']) {
    if (typeof creditRepository?.[method] !== 'function') throw new TypeError(`Usage reservation service requires creditRepository.${method}().`);
  }
  for (const method of ['getWorkspacePolicyForUpdate', 'reserveExposure', 'releaseExposure', 'getExposure']) {
    if (typeof postpaidRepository?.[method] !== 'function') throw new TypeError(`Usage reservation service requires postpaidRepository.${method}().`);
  }
  const postpaidFundingSource = createPostpaidFundingSource({ repository: postpaidRepository });
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Usage reservation service requires an ID source and clock.');
  if (typeof authorizeUsage !== 'function' || typeof resolveFundingPolicy !== 'function') throw new TypeError('Usage reservation service requires authorization and funding policy resolvers.');

  async function authorize(actor, orgId, action, details = {}) {
    if (await authorizeUsage({ actor, orgId, action, ...details }) !== true) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor is not authorized for this workspace usage funding operation.');
    }
  }

  async function loadPolicy(tx, { orgId, workspace, billingAccount, service, now, requestedVersion, expectedPeriodId }) {
    const resolvedValue = await resolveFundingPolicy({ tx, orgId, workspace, service, now, billingAccount });
    const resolved = resolvedValue && typeof resolvedValue === 'object' ? { ...resolvedValue } : resolvedValue;
    if (!resolved || typeof resolved !== 'object' || typeof resolved.serviceAllowed !== 'boolean') {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Funding policy resolver returned an invalid service entitlement.');
    }
    const version = billingAccount.enforcementVersion;
    if (requestedVersion !== undefined && requestedVersion !== version) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Funding policy version is stale.', { details: { requestedVersion, actualVersion: version } });
    }
    if (expectedPeriodId && resolved.cyclePeriodId !== expectedPeriodId) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Reservation funding period changed before extension.', { details: { expectedPeriodId, actualPeriodId: resolved.cyclePeriodId || null } });
    }
    if (resolved.workspaceCycleCap) {
      const cap = validateAmount(resolved.workspaceCycleCap);
      if (!resolved.cyclePeriodId || !resolved.periodStartAt || !resolved.periodEndAt) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Workspace cycle cap requires an active billing period window.');
      }
      const exposure = await reservationRepository.getWorkspaceCycleExposure(tx, {
        orgId, workspaceId: workspace.id, periodStart: resolved.periodStartAt, periodEnd: resolved.periodEndAt,
        asset: cap.asset, scale: cap.scale,
      });
      resolved.workspaceCycleUsedUnits = exposure.usedUnits;
      resolved.workspaceCycleHeldUnits = exposure.heldUnits;
    }
    if (billingAccount.fallbackMode === 'postpaid') {
      const configured = await postpaidRepository.getWorkspacePolicyForUpdate(tx, { orgId, workspaceId: workspace.id });
      resolved.postpaidPolicy = configured?.enabled
        ? { enabled: true, mode: configured.mode, cycleLimit: configured.cycleLimit, version: configured.version }
        : { enabled: false, mode: 'disabled', cycleLimit: null, version: configured?.version || 0 };
      resolved.postpaidEligible = resolved.postpaidEligible === true;
      resolved.allowedPostpaidModes = Array.isArray(resolved.allowedPostpaidModes) ? resolved.allowedPostpaidModes : [];
      resolved.postpaidPeriodId = resolved.postpaidPeriodId || resolved.cyclePeriodId || null;
      resolved.organizationExposureLimit = resolved.organizationExposureLimit || null;
      const asset = resolved.postpaidPolicy.cycleLimit?.asset || resolved.organizationExposureLimit?.asset || resolved.postpaidAsset;
      const scale = resolved.postpaidPolicy.cycleLimit?.scale ?? resolved.organizationExposureLimit?.scale ?? resolved.postpaidScale;
      if (resolved.postpaidPeriodId && asset && Number.isInteger(scale)) {
        Object.assign(resolved, await postpaidRepository.getExposure(tx, { orgId, workspaceId: workspace.id, periodId: resolved.postpaidPeriodId, asset, scale }));
      } else if (resolved.postpaidEligible && resolved.postpaidPolicy.enabled) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Postpaid funding requires an active period and billing asset/scale.');
      }
    }
    return Object.freeze({
      ...resolved,
      version,
      fallbackMode: billingAccount.fallbackMode,
      serviceKey: service,
    });
  }

  async function getActiveWorkspace(tx, { orgId, workspaceId }) {
    const workspace = await reservationRepository.getWorkspaceForUpdate(tx, { orgId, workspaceId });
    if (!workspace) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Workspace was not found in this organization.');
    if (String(workspace.status || '').toLowerCase() !== 'active') throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Usage cannot be reserved for a suspended workspace.');
    return workspace;
  }

  async function lockedReservePosition(tx, orgId, workspaceId, line) {
    const grant = asGrant(await creditRepository.getGrantForUpdate(tx, { orgId, grantId: line.grantId }));
    const position = await creditRepository.getPositionForUpdate(tx, { orgId, grantId: line.grantId, accountId: line.accountId });
    if (!position) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Workspace credit position disappeared before reservation.');
    if (position.accountStatus !== 'active' || position.accountPurpose !== 'pool'
      || position.scope?.orgId !== orgId || position.scope?.ownerType !== 'workspace' || position.scope?.ownerId !== workspaceId) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Reservation source must be an active workspace pool owned by the requested workspace.');
    }
    return {
      grant,
      position: {
        ...position,
        accountId: line.accountId,
        grantId: line.grantId,
        balanceUnits: position.amount.units,
        status: position.accountStatus,
        accountPurpose: position.accountPurpose,
      },
    };
  }

  async function holdLines(tx, { orgId, workspaceId, reservationId, lines, actor, operationId, now }) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.fundingSource === 'postpaid') continue;
      const { grant, position } = await lockedReservePosition(tx, orgId, workspaceId, line);
      const plan = planReserve({
        orgId,
        operationId: childOperationId(operationId, `hold:${index}:${line.grantId}`),
        grant,
        position,
        amount: line.amount,
        reservationId,
        actor,
        now,
        reason: `Hold workspace usage funding for ${reservationId}`,
      });
      await creditRepository.applyJournal(tx, { ...plan.journal, positionDeltas: plan.positionDeltas });
    }
  }

  async function currentExposure(tx, { orgId, workspaceId, policy, amount, excludeReservationId, additionalHeldUnits = '0' }) {
    if (!policy.workspaceCycleCap) return policy;
    const cap = validateAmount(policy.workspaceCycleCap);
    if (cap.asset !== amount.asset || cap.scale !== amount.scale) throw new BillingDomainError(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Workspace cycle cap uses a different credit asset or scale.');
    const exposure = await reservationRepository.getWorkspaceCycleExposure(tx, {
      orgId, workspaceId, periodStart: policy.periodStartAt, periodEnd: policy.periodEndAt,
      asset: cap.asset, scale: cap.scale, excludeReservationId,
    });
    return Object.freeze({ ...policy, workspaceCycleUsedUnits: exposure.usedUnits,
      workspaceCycleHeldUnits: (BigInt(exposure.heldUnits) + BigInt(additionalHeldUnits)).toString() });
  }

  async function loadReservation(tx, orgId, reservationId) {
    const reservation = await reservationRepository.getForUpdate(tx, { orgId, reservationId });
    if (!reservation) throw new BillingDomainError(DOMAIN_ERROR_CODES.RESERVATION_NOT_FOUND, 'Usage reservation was not found.');
    const lines = await reservationRepository.listLinesForUpdate(tx, { orgId, reservationId });
    return { reservation, lines };
  }

  async function reserveUsage({ command, trustedContext } = {}) {
    const value = validateUsageFundingRequest(command, trustedContext);
    const workspaceId = value.scope.ownerId;
    await authorize(value.context.actor, value.orgId, 'usage.reserve', { workspaceId, service: value.service });
    const request = requestSnapshot(value);
    const requestFingerprint = fingerprint({ orgId: value.orgId, workspaceId, usageOperationId: value.usageOperationId, request, actorId: value.context.actor.id });
    const now = clock.now();
    return unitOfWork.runFinancial({
      orgId: value.orgId, operationId: value.context.operationId, requestFingerprint,
      expectedVersions: value.context.expectedVersions,
      callback: async (tx) => {
        const workspace = await getActiveWorkspace(tx, { orgId: value.orgId, workspaceId });
        const billingAccount = await reservationRepository.getBillingAccountForUpdate(tx, { orgId: value.orgId });
        const prior = await reservationRepository.getByUsageKey(tx, {
          orgId: value.orgId, workspaceId, usageOperationId: value.usageOperationId,
          sourceRevision: request.sourceRevision, forUpdate: true,
        });
        if (prior) {
          const priorRequest = objectSnapshot(prior.fundingSnapshot).request;
          if (stableJson(priorRequest) !== stableJson(request)) throw new BillingDomainError(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Usage operation revision already has a different reservation request.');
          return Object.freeze({ reservation: prior, lines: await reservationRepository.listLinesForUpdate(tx, { orgId: value.orgId, reservationId: prior.id }), duplicate: true });
        }

        const policy = await loadPolicy(tx, { orgId: value.orgId, workspace, billingAccount, service: value.service, now, requestedVersion: value.policyVersion });
        if (value.expectedWorkspaceVersion !== undefined && policy.workspaceVersion !== value.expectedWorkspaceVersion) {
          throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Workspace version is stale or unavailable for funding.', {
            details: { expectedVersion: value.expectedWorkspaceVersion, actualVersion: policy.workspaceVersion ?? null },
          });
        }
        const eligiblePositions = await reservationRepository.listWorkspacePositionsForUpdate(tx, { orgId: value.orgId, workspaceId });
        const fundingPlan = planFunding({
          scope: value.scope, amount: value.estimatedAmount, positions: eligiblePositions,
          policy, now, validUntil: value.validUntil,
        });
        await reservePostpaidLines(postpaidFundingSource, tx, { orgId: value.orgId, workspaceId, policy, lines: fundingPlan.lines });
        const reservationId = idSource.newId('billing-reservation');
        const fundingSnapshot = {
          schemaVersion: 1,
          request,
          policy: snapshotPolicy(policy),
          funding: fundingPlan.lines.map((line) => ({ fundingSource: line.fundingSource, grantId: line.grantId, positionId: line.positionId, amount: line.amount, grantExpiresAt: line.grantExpiresAt, snapshot: line.fundingSnapshot })),
        };
        const reservation = await reservationRepository.createReservation(tx, {
          id: reservationId, orgId: value.orgId, workspaceId, usageOperationId: value.usageOperationId,
          sourceRevision: request.sourceRevision, fundingPolicyVersion: fundingPlan.policyVersion,
          fundingSnapshot, validUntil: value.validUntil,
          lines: fundingPlan.lines, now,
        });
        await holdLines(tx, {
          orgId: value.orgId, workspaceId, reservationId, lines: fundingPlan.lines,
          actor: value.context.actor, operationId: value.context.operationId, now,
        });
        return Object.freeze({ reservation, lines: await reservationRepository.listLinesForUpdate(tx, { orgId: value.orgId, reservationId }), duplicate: false });
      },
    });
  }

  async function extendUsage({ command, trustedContext } = {}) {
    const value = validateUsageReservationExtension(command, trustedContext);
    await authorize(value.context.actor, value.orgId, 'usage.extend', { workspaceId: value.workspaceId, reservationId: value.reservationId });
    const requestFingerprint = fingerprint({ orgId: value.orgId, workspaceId: value.workspaceId, reservationId: value.reservationId, additionalAmount: value.additionalAmount, pricingSnapshot: value.pricingSnapshot, validUntil: value.validUntil, expectedVersion: value.expectedVersion, actorId: value.context.actor.id });
    const now = clock.now();
    return unitOfWork.runFinancial({
      orgId: value.orgId, operationId: value.context.operationId, requestFingerprint,
      expectedVersions: value.context.expectedVersions,
      callback: async (tx) => {
        const { reservation, lines } = await loadReservation(tx, value.orgId, value.reservationId);
        if (reservation.workspaceId !== value.workspaceId) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Usage reservation belongs to a different workspace.');
        if (reservation.version !== value.expectedVersion) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Usage reservation version is stale.', { details: { expectedVersion: value.expectedVersion, actualVersion: reservation.version } });
        if (!['reserved', 'partially_consumed'].includes(reservation.status)) throw new BillingDomainError(DOMAIN_ERROR_CODES.RESERVATION_STATE_CONFLICT, 'Only an open usage reservation can be extended.');
        if (Date.parse(reservation.validUntil) <= Date.parse(now)) throw new BillingDomainError(DOMAIN_ERROR_CODES.RESERVATION_STATE_CONFLICT, 'Expired reservations cannot be extended.');
        if (Date.parse(value.validUntil) <= Date.parse(now) || Date.parse(value.validUntil) < Date.parse(reservation.validUntil)) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Extended validUntil must be future and no earlier than the current reservation end.');
        for (const line of lines) {
          if (emptyRemaining(line) > 0n && line.fundingSnapshot.grantExpiresAt && Date.parse(value.validUntil) > Date.parse(line.fundingSnapshot.grantExpiresAt)) {
            throw new BillingDomainError(DOMAIN_ERROR_CODES.GRANT_EXPIRED, 'Reservation extension cannot cross an expiry boundary for an existing held grant; close this usage segment and reserve a new one.');
          }
        }
        const workspace = await getActiveWorkspace(tx, { orgId: value.orgId, workspaceId: reservation.workspaceId });
        const billingAccount = await reservationRepository.getBillingAccountForUpdate(tx, { orgId: value.orgId });
        const request = objectSnapshot(reservation.fundingSnapshot).request || {};
        const policy = await loadPolicy(tx, { orgId: value.orgId, workspace, billingAccount, service: request.service, now, requestedVersion: Number(reservation.fundingPolicyVersion) });
        const currentlyHeld = lines.reduce((sum, line) => sum + (emptyRemaining(line) > 0n ? emptyRemaining(line) : 0n), 0n).toString();
        const policyWithExposure = await currentExposure(tx, {
          orgId: value.orgId, workspaceId: reservation.workspaceId, policy, amount: value.additionalAmount,
          excludeReservationId: reservation.id, additionalHeldUnits: currentlyHeld,
        });
        const eligiblePositions = await reservationRepository.listWorkspacePositionsForUpdate(tx, { orgId: value.orgId, workspaceId: reservation.workspaceId });
        const fundingPlan = planFunding({
          scope: workspaceScope(value.orgId, reservation.workspaceId), amount: value.additionalAmount,
          positions: eligiblePositions, policy: policyWithExposure, now, validUntil: value.validUntil,
        });
        await reservePostpaidLines(postpaidFundingSource, tx, { orgId: value.orgId, workspaceId: reservation.workspaceId, policy: policyWithExposure, lines: fundingPlan.lines });
        const snapshot = {
          ...objectSnapshot(reservation.fundingSnapshot),
          extensions: [...(objectSnapshot(reservation.fundingSnapshot).extensions || []), {
            operationId: value.context.operationId, amount: value.additionalAmount, pricingSnapshot: value.pricingSnapshot, validUntil: value.validUntil,
            policy: snapshotPolicy(policyWithExposure), funding: fundingPlan.lines.map((line) => ({ fundingSource: line.fundingSource, grantId: line.grantId, amount: line.amount, grantExpiresAt: line.grantExpiresAt, snapshot: line.fundingSnapshot })),
          }],
        };
        await holdLines(tx, {
          orgId: value.orgId, workspaceId: reservation.workspaceId, reservationId: reservation.id, lines: fundingPlan.lines,
          actor: value.context.actor, operationId: value.context.operationId, now,
        });
        await reservationRepository.appendLines(tx, { orgId: value.orgId, reservationId: reservation.id, lines: fundingPlan.lines, now });
        const updated = await reservationRepository.updateReservation(tx, {
          orgId: value.orgId, reservationId: reservation.id, expectedVersion: reservation.version,
          status: reservation.status, validUntil: value.validUntil, fundingSnapshot: snapshot, now,
        });
        return Object.freeze({ reservation: updated, lines: await reservationRepository.listLinesForUpdate(tx, { orgId: value.orgId, reservationId: reservation.id }), duplicate: false });
      },
    });
  }

  async function releaseUsage({ command, trustedContext } = {}) {
    const value = validateUsageReservationRelease(command, trustedContext);
    await authorize(value.context.actor, value.orgId, 'usage.release', { workspaceId: value.workspaceId, reservationId: value.reservationId });
    const requestFingerprint = fingerprint({ orgId: value.orgId, workspaceId: value.workspaceId, reservationId: value.reservationId, expectedVersion: value.expectedVersion, actorId: value.context.actor.id });
    const now = clock.now();
    return unitOfWork.runFinancial({
      orgId: value.orgId, operationId: value.context.operationId, requestFingerprint,
      expectedVersions: value.context.expectedVersions,
      callback: async (tx) => {
        const { reservation, lines } = await loadReservation(tx, value.orgId, value.reservationId);
        if (reservation.workspaceId !== value.workspaceId) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Usage reservation belongs to a different workspace.');
        if (reservation.version !== value.expectedVersion) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Usage reservation version is stale.', { details: { expectedVersion: value.expectedVersion, actualVersion: reservation.version } });
        if (reservation.status === 'released') return Object.freeze({ reservation, lines, duplicate: true });
        if (!['reserved', 'partially_consumed'].includes(reservation.status)) throw new BillingDomainError(DOMAIN_ERROR_CODES.RESERVATION_STATE_CONFLICT, 'Only an open usage reservation can be released.');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const remaining = emptyRemaining(line);
          if (remaining <= 0n) continue;
          if (line.fundingSource === 'postpaid') {
            await postpaidFundingSource.release(tx, {
              orgId: value.orgId, workspaceId: reservation.workspaceId, periodId: line.periodId,
              amount: { asset: line.amount.asset, units: remaining.toString(), scale: line.amount.scale },
              organizationLimitApplied: line.fundingSnapshot.organizationLimitApplied === true,
            });
            await reservationRepository.markLineReleased(tx, { orgId: value.orgId, line, now });
            continue;
          }
          const grant = asGrant(await creditRepository.getGrantForUpdate(tx, { orgId: value.orgId, grantId: line.grantId }));
          const position = await creditRepository.getPositionForUpdate(tx, { orgId: value.orgId, grantId: line.grantId, accountId: line.accountId });
          if (!position) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Reserved workspace credit position was not found.');
          if (position.accountStatus !== 'active' || position.accountPurpose !== 'pool'
            || position.scope?.orgId !== value.orgId || position.scope?.ownerType !== 'workspace' || position.scope?.ownerId !== reservation.workspaceId) {
            throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Reservation can only release funds from its original workspace pool.');
          }
          const amount = { asset: line.amount.asset, units: remaining.toString(), scale: line.amount.scale };
          const expired = grant.status === 'expired' || (grant.expiresAt && Date.parse(now) >= Date.parse(grant.expiresAt));
          const expiryAccount = expired ? await creditRepository.ensureAccount(tx, {
            orgId: value.orgId, accountType: 'organization', ownerId: value.orgId,
            asset: amount.asset, scale: amount.scale, accountPurpose: 'expiry_clearing', now,
          }) : null;
          const plan = planRelease({
            orgId: value.orgId,
            operationId: childOperationId(value.context.operationId, `release:${index}:${line.grantId}`),
            grant,
            position: {
              ...position, accountId: line.accountId, grantId: line.grantId,
              balanceUnits: position.amount.units, status: position.accountStatus, accountPurpose: position.accountPurpose,
            },
            amount, reservationId: reservation.id,
            expiryClearingAccountId: expiryAccount?.id,
            actor: value.context.actor, now,
            reason: `Release workspace usage reservation ${reservation.id}`,
          });
          if (plan.journal || plan.grantPatch) {
            const journal = plan.journal || {
              orgId: value.orgId,
              operationId: childOperationId(value.context.operationId, `release-expired:${index}:${line.grantId}`),
              operationType: 'credit_release', sourceType: 'usage_reservation', sourceId: reservation.id,
              actorType: value.context.actor.type, actorId: value.context.actor.id, now, entries: [],
            };
            await creditRepository.applyJournal(tx, { ...journal, positionDeltas: plan.positionDeltas, grantPatch: plan.grantPatch });
          }
          await reservationRepository.markLineReleased(tx, { orgId: value.orgId, line, now });
        }
        const updated = await reservationRepository.updateReservation(tx, {
          orgId: value.orgId, reservationId: reservation.id, expectedVersion: reservation.version,
          status: 'released', validUntil: reservation.validUntil,
          fundingSnapshot: { ...objectSnapshot(reservation.fundingSnapshot), releasedAt: now },
          closedAt: now, now,
        });
        return Object.freeze({ reservation: updated, lines: await reservationRepository.listLinesForUpdate(tx, { orgId: value.orgId, reservationId: reservation.id }), duplicate: false });
      },
    });
  }

  return Object.freeze({ reserveUsage, extendUsage, releaseUsage });
}

function snapshotPolicy(policy) {
  const result = {
    version: policy.version,
    fallbackMode: policy.fallbackMode,
    serviceKey: policy.serviceKey,
    serviceAllowed: policy.serviceAllowed,
    workspaceVersion: policy.workspaceVersion ?? null,
    cyclePeriodId: policy.cyclePeriodId || null,
    periodStartAt: policy.periodStartAt || null,
    periodEndAt: policy.periodEndAt || null,
    workspaceCycleCap: policy.workspaceCycleCap || null,
    postpaidPolicy: policy.postpaidPolicy || null,
    postpaidEligible: policy.postpaidEligible === true,
    allowedPostpaidModes: policy.allowedPostpaidModes || [],
    postpaidPeriodId: policy.postpaidPeriodId || null,
    organizationExposureLimit: policy.organizationExposureLimit || null,
    snapshot: policy.snapshot || null,
  };
  let encoded;
  try { encoded = JSON.stringify(result); } catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Resolved usage policy must be JSON-safe.', { details: { cause: cause.message } }); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Resolved usage policy snapshot is too large.');
  return JSON.parse(encoded);
}

async function reservePostpaidLines(postpaidFundingSource, tx, { orgId, workspaceId, policy, lines }) {
  for (const line of lines) {
    if (line.fundingSource !== 'postpaid') continue;
    if (!postpaidFundingSource.supports({ fallbackMode: policy.fallbackMode, workspacePolicy: policy.postpaidPolicy })) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.POSTPAID_DISABLED, 'Postpaid funding source is not available for this workspace.');
    }
    await postpaidFundingSource.reserve(tx, {
      orgId, workspaceId, periodId: line.periodId, amount: line.amount,
      workspaceLimit: policy.postpaidPolicy.mode === 'limited' ? policy.postpaidPolicy.cycleLimit : null,
      organizationLimit: policy.organizationExposureLimit,
    });
  }
}

module.exports = { createUsageReservationService, usageReservationFingerprint: fingerprint };
