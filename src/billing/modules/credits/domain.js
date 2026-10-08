'use strict';

// Pure credit-ledger planners. They deliberately do not read cached account
// totals or write persistence: callers pass locked grant/position snapshots,
// then commit the returned journal and position deltas in one billing UoW.
const { validateAmount } = require('../../kernel/amount');
const { validateId, validateScope } = require('../../kernel/scope');
const { DOMAIN_ERROR_CODES, BillingDomainError } = require('../../contracts/errors');
const { authenticatedActor } = require('../../contracts/validation');

const { FORBIDDEN, GRANT_NOT_AVAILABLE, GRANT_EXPIRED, INSUFFICIENT_CREDITS,
  INVALID_CONTRACT, RESERVATION_STATE_CONFLICT } = DOMAIN_ERROR_CODES;
const CLEARING_ENTRY_TYPES = new Set(['funding_clearing', 'usage_clearing', 'expiry_clearing', 'allocation_clearing']);

function fail(code, message, details) {
  throw new BillingDomainError(code, message, { details });
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(INVALID_CONTRACT, `${name} must be an ISO timestamp.`);
  }
  return Date.parse(value);
}

function actor(value) {
  try { return authenticatedActor(value); } catch (error) { fail(INVALID_CONTRACT, 'actor must be trusted user or system identity.', { cause: error.message }); }
}

function positiveAmount(value) {
  let amount;
  try { amount = validateAmount(value); } catch (error) { fail(INVALID_CONTRACT, 'amount must be a valid exact billing amount.', { cause: error.message }); }
  if (BigInt(amount.units) <= 0n) fail(INVALID_CONTRACT, 'amount must be greater than zero.');
  return amount;
}

function snapshot(position, grant, expectedOrgId) {
  if (!position || typeof position !== 'object') fail(INVALID_CONTRACT, 'position snapshot is required.');
  if (!grant || typeof grant !== 'object') fail(INVALID_CONTRACT, 'grant snapshot is required.');
  const accountId = validateId(position.accountId, 'position.accountId');
  const grantId = validateId(position.grantId, 'position.grantId');
  if (grantId !== grant.id) fail(INVALID_CONTRACT, 'position grantId does not match grant.');
  const balanceValue = position.balanceUnits ?? position.amount?.units;
  const balance = integer(balanceValue, 'position.balanceUnits');
  const reserved = integer(position.reservedUnits, 'position.reservedUnits');
  if (balance < 0n || reserved < 0n || reserved > balance) fail(RESERVATION_STATE_CONFLICT, 'position must have non-negative balance and reserved units no greater than balance.');
  const amount = validateAmount(grant.amount);
  if (grant.orgId !== undefined) {
    validateId(grant.orgId, 'grant.orgId');
    if (expectedOrgId && grant.orgId !== expectedOrgId) fail(FORBIDDEN, 'grant belongs to another organization.');
  }
  const positionAsset = position.asset ?? position.amount?.asset;
  const positionScale = position.scale ?? position.amount?.scale;
  if (positionAsset !== undefined && positionAsset !== amount.asset) fail(INVALID_CONTRACT, 'position asset does not match grant.');
  if (positionScale !== undefined && positionScale !== amount.scale) fail(INVALID_CONTRACT, 'position scale does not match grant.');
  if (position.status !== undefined && position.status !== 'active') fail(FORBIDDEN, 'credit account is not active.');
  if (position.scope !== undefined && validateScope(position.scope).orgId !== (expectedOrgId || grant.orgId)) fail(FORBIDDEN, 'position scope belongs to another organization.');
  if (grant.status !== undefined && !['active', 'scheduled', 'expired', 'revoked', 'reversed'].includes(grant.status)) fail(INVALID_CONTRACT, 'grant status is invalid.');
  return Object.freeze({ accountId, grantId, balance, reserved, amount, accountPurpose: position.accountPurpose || null });
}

function integer(value, field) {
  if (typeof value !== 'string' || !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value)) fail(INVALID_CONTRACT, `${field} must be a canonical integer string.`);
  return BigInt(value);
}

function sameAmount(a, b) {
  return a.asset === b.asset && a.scale === b.scale;
}

function grantActive(grant, now) {
  if (grant.status && grant.status !== 'active') fail(GRANT_NOT_AVAILABLE, `grant status ${grant.status} is not available.`);
  if (timestamp(now, 'now') < timestamp(grant.effectiveAt, 'grant.effectiveAt')) fail(GRANT_NOT_AVAILABLE, 'grant is not effective yet.');
  if (grant.expiresAt !== null && grant.expiresAt !== undefined && timestamp(now, 'now') >= timestamp(grant.expiresAt, 'grant.expiresAt')) {
    fail(GRANT_EXPIRED, 'grant has expired.');
  }
}

function baseCommand({ orgId, operationId, operationType, actor: actorValue, reason, now, sourceType, sourceId }) {
  validateId(orgId, 'orgId');
  validateId(operationId, 'operationId');
  const trustedActor = actor(actorValue);
  if (trustedActor.organizationId !== undefined && trustedActor.organizationId !== orgId) fail(FORBIDDEN, 'actor does not belong to the command organization.');
  timestamp(now, 'now');
  const command = { orgId, operationId, operationType, actorType: trustedActor.type, actorId: trustedActor.id, now };
  if (sourceType !== undefined) command.sourceType = sourceType;
  if (sourceId !== undefined) command.sourceId = sourceId;
  if (reason !== undefined) command.reason = String(reason).slice(0, 1000);
  return command;
}

function entry(accountId, grantId, units, amount, entryType) {
  validateId(accountId, 'accountId');
  return Object.freeze({ accountId, ...(grantId ? { grantId } : {}), amountUnits: BigInt(units).toString(), asset: amount.asset, scale: amount.scale, entryType });
}

function positionDelta(accountId, grantId, balanceDeltaUnits = 0n, reservedDeltaUnits = 0n, amount) {
  return Object.freeze({ accountId, grantId, ...(amount ? { asset: amount.asset, scale: amount.scale } : {}), balanceDeltaUnits: BigInt(balanceDeltaUnits).toString(), reservedDeltaUnits: BigInt(reservedDeltaUnits).toString() });
}

function expiryGrantPatch(grant) {
  if (grant.status === 'expired') return undefined;
  return Object.freeze({ grantId: grant.id, status: 'expired', expectedStatus: grant.status || 'active' });
}

function planIssueGrant({ orgId, operationId, grant, adminAccountId, fundingClearingAccountId, actor: actorValue, now, reason }) {
  validateId(grant.id, 'grant.id');
  if (!['subscription', 'topup'].includes(grant.kind)) fail(INVALID_CONTRACT, 'grant.kind must be subscription or topup.');
  if (grant.status !== undefined && grant.status !== 'active') fail(INVALID_CONTRACT, 'issued grants must begin active; scheduled periods are funded at activation.');
  validateId(grant.sourceType, 'grant.sourceType');
  validateId(grant.sourceId, 'grant.sourceId');
  validateId(grant.sourceEventKey, 'grant.sourceEventKey');
  const amount = positiveAmount(grant.amount);
  const effectiveAt = grant.effectiveAt;
  timestamp(effectiveAt, 'grant.effectiveAt');
  const expiresAt = grant.expiresAt === null || grant.expiresAt === undefined ? null : grant.expiresAt;
  if (expiresAt !== null && timestamp(expiresAt, 'grant.expiresAt') <= timestamp(effectiveAt, 'grant.effectiveAt')) fail(INVALID_CONTRACT, 'grant expiry must be after its effective time.');
  if (grant.kind === 'subscription' && expiresAt === null) fail(INVALID_CONTRACT, 'subscription grants require expiry.');
  if (grant.kind === 'topup' && expiresAt !== null) fail(INVALID_CONTRACT, 'top-up grants must not expire.');
  const adminScope = validateScope(grant.accountScope);
  if (adminScope.orgId !== orgId || adminScope.ownerType !== 'organization' || adminScope.ownerId !== orgId) fail(FORBIDDEN, 'new credit grants must be issued to the organization admin pool.');
  const accounts = [adminAccountId, fundingClearingAccountId].map((id, i) => validateId(id, i ? 'fundingClearingAccountId' : 'adminAccountId'));
  if (accounts[0] === accounts[1]) fail(INVALID_CONTRACT, 'funding and admin accounts must differ.');
  const cmd = baseCommand({ orgId, operationId, operationType: 'credit_issue', actor: actorValue, now, reason, sourceType: grant.sourceType, sourceId: grant.sourceId });
  const grantRecord = Object.freeze({
    id: grant.id, orgId, kind: grant.kind, grantKind: grant.kind, sourceType: grant.sourceType, sourceId: grant.sourceId,
    sourceEventKey: grant.sourceEventKey, amount, effectiveAt, expiresAt, status: 'active',
    ...(grant.periodId ? { periodId: grant.periodId } : {}),
    ...(grant.paymentRequestId ? { paymentRequestId: grant.paymentRequestId } : {}),
  });
  return Object.freeze({
    grant: grantRecord,
    journal: Object.freeze({ ...cmd, entries: Object.freeze([
      entry(accounts[0], grant.id, amount.units, amount, 'grant_issue'),
      entry(accounts[1], grant.id, -BigInt(amount.units), amount, 'funding_clearing'),
    ]) }),
    positionDeltas: Object.freeze([positionDelta(accounts[0], grant.id, BigInt(amount.units), 0n, amount)]),
  });
}

function planTransfer({ orgId, operationId, grant, from, to, fromScope, toScope, amount: amountValue, actor: actorValue, now, reason, allowSameScope = false, allowExpiredReturn = false }) {
  const state = snapshot(from, grant, orgId);
  const amount = positiveAmount(amountValue);
  if (!sameAmount(state.amount, amount)) fail(INVALID_CONTRACT, 'transfer amount asset and scale must match grant.');
  const sourceScope = validateScope(fromScope);
  const targetScope = validateScope(toScope);
  if (sourceScope.orgId !== orgId || targetScope.orgId !== orgId || sourceScope.orgId !== targetScope.orgId) fail(FORBIDDEN, 'transfer scopes must belong to the command organization.');
  const sameScope = sourceScope.ownerId === targetScope.ownerId && sourceScope.ownerType === targetScope.ownerType;
  if (sameScope && !allowSameScope) fail(INVALID_CONTRACT, 'transfer source and destination must differ.');
  if (from.scope && JSON.stringify(validateScope(from.scope)) !== JSON.stringify(sourceScope)) fail(FORBIDDEN, 'source account scope does not match source position.');
  if (to && to.scope && JSON.stringify(validateScope(to.scope)) !== JSON.stringify(targetScope)) fail(FORBIDDEN, 'destination account scope does not match destination scope.');
  const toAccountId = validateId(to && (to.id || to.accountId), 'to.accountId');
  if (state.accountId === toAccountId) fail(INVALID_CONTRACT, 'transfer source and destination accounts must differ.');
  if (BigInt(amount.units) > state.balance - state.reserved) fail(INSUFFICIENT_CREDITS, 'transfer exceeds available, unheld credits.');
  if (allowExpiredReturn) {
    const targetIsAdmin = targetScope.ownerType === 'organization' && targetScope.ownerId === orgId;
    const grantStatusAllowsReturn = !grant.status || ['active', 'expired'].includes(grant.status);
    if (!targetIsAdmin || !grantStatusAllowsReturn || timestamp(now, 'now') < timestamp(grant.effectiveAt, 'grant.effectiveAt')) {
      fail(GRANT_NOT_AVAILABLE, 'expired-credit return is allowed only from an active or expired grant to its organization admin pool.');
    }
  } else grantActive(grant, now);
  const cmd = baseCommand({ orgId, operationId, operationType: 'credit_transfer', actor: actorValue, now, reason, sourceType: 'credit_transfer', sourceId: operationId });
  return Object.freeze({
    grant: Object.freeze({ id: grant.id, expiresAt: grant.expiresAt === undefined ? null : grant.expiresAt }),
    journal: Object.freeze({ ...cmd, entries: Object.freeze([
      entry(state.accountId, state.grantId, -BigInt(amount.units), amount, 'transfer_out'),
      entry(toAccountId, state.grantId, BigInt(amount.units), amount, 'transfer_in'),
    ]) }),
    positionDeltas: Object.freeze([
      positionDelta(state.accountId, state.grantId, -BigInt(amount.units), 0n, amount),
      positionDelta(toAccountId, state.grantId, BigInt(amount.units), 0n, amount),
    ]),
  });
}

function planReserve({ orgId, operationId, grant, position, amount: amountValue, reservationId, actor: actorValue, now, reason }) {
  const state = snapshot(position, grant, orgId);
  const amount = positiveAmount(amountValue);
  if (!sameAmount(state.amount, amount)) fail(INVALID_CONTRACT, 'reserve amount asset and scale must match grant.');
  validateId(reservationId, 'reservationId');
  grantActive(grant, now);
  if (BigInt(amount.units) > state.balance - state.reserved) fail(INSUFFICIENT_CREDITS, 'reservation exceeds available credits.');
  const cmd = baseCommand({ orgId, operationId, operationType: 'credit_reserve', actor: actorValue, now, reason, sourceType: 'usage_reservation', sourceId: reservationId });
  return Object.freeze({
    journal: Object.freeze({ ...cmd, entries: Object.freeze([
      entry(state.accountId, state.grantId, BigInt(amount.units), amount, 'reserve_hold'),
      entry(state.accountId, state.grantId, -BigInt(amount.units), amount, 'reserve_offset'),
    ]) }),
    positionDeltas: Object.freeze([positionDelta(state.accountId, state.grantId, 0n, BigInt(amount.units), amount)]),
  });
}

function planConsume({ orgId, operationId, grant, position, amount: amountValue, reservationId, usageOccurredAt, usageClearingAccountId, actor: actorValue, now, reason }) {
  const state = snapshot(position, grant, orgId);
  const amount = positiveAmount(amountValue);
  if (!sameAmount(state.amount, amount)) fail(INVALID_CONTRACT, 'consume amount asset and scale must match grant.');
  const units = BigInt(amount.units);
  const expired = grant.status === 'expired' || (grant.expiresAt !== null && grant.expiresAt !== undefined && timestamp(now, 'now') >= timestamp(grant.expiresAt, 'grant.expiresAt'));
  if (reservationId) {
    validateId(reservationId, 'reservationId');
    if (units > state.reserved) fail(RESERVATION_STATE_CONFLICT, 'consume amount exceeds held credits.');
    if (!['active', 'expired'].includes(grant.status || 'active')) fail(GRANT_NOT_AVAILABLE, 'grant status cannot settle a reservation.');
    if (timestamp(now, 'now') < timestamp(grant.effectiveAt, 'grant.effectiveAt')) fail(GRANT_NOT_AVAILABLE, 'grant is not effective yet.');
    if (expired) {
      if (!grant.expiresAt) fail(GRANT_EXPIRED, 'a non-expiring grant in expired status cannot be consumed.');
      if (!usageOccurredAt || timestamp(usageOccurredAt, 'usageOccurredAt') >= timestamp(grant.expiresAt, 'grant.expiresAt')) fail(GRANT_EXPIRED, 'expired credits can settle only usage that occurred before expiry.');
    } else if (usageOccurredAt && timestamp(usageOccurredAt, 'usageOccurredAt') >= timestamp(grant.expiresAt || '9999-12-31T23:59:59Z', 'grant.expiresAt')) {
      fail(GRANT_EXPIRED, 'usage occurred at or after grant expiry.');
    }
  } else {
    grantActive(grant, now);
    if (units > state.balance - state.reserved) fail(INSUFFICIENT_CREDITS, 'consume amount exceeds available credits.');
  }
  const sinkId = validateId(usageClearingAccountId, 'usageClearingAccountId');
  const cmd = baseCommand({ orgId, operationId, operationType: 'credit_consume', actor: actorValue, now, reason, sourceType: reservationId ? 'usage_reservation' : 'usage', sourceId: reservationId || operationId });
  return Object.freeze({
    journal: Object.freeze({ ...cmd, ...(usageOccurredAt ? { occurredAt: usageOccurredAt } : {}), entries: Object.freeze([
      entry(state.accountId, state.grantId, -units, amount, 'credit_consumption'),
      entry(sinkId, state.grantId, units, amount, 'usage_clearing'),
    ]) }),
    positionDeltas: Object.freeze([positionDelta(state.accountId, state.grantId, -units, reservationId ? -units : 0n, amount)]),
  });
}

function planRelease({ orgId, operationId, grant, position, amount: amountValue, reservationId, expiryClearingAccountId, actor: actorValue, now, reason }) {
  const state = snapshot(position, grant, orgId);
  const amount = positiveAmount(amountValue);
  if (!sameAmount(state.amount, amount)) fail(INVALID_CONTRACT, 'release amount asset and scale must match grant.');
  const units = BigInt(amount.units);
  validateId(reservationId, 'reservationId');
  if (units > state.reserved) fail(RESERVATION_STATE_CONFLICT, 'release amount exceeds held credits.');
  const expired = grant.status === 'expired' || (grant.expiresAt !== null && grant.expiresAt !== undefined && timestamp(now, 'now') >= timestamp(grant.expiresAt, 'grant.expiresAt'));
  if (!expired && grant.status && grant.status !== 'active') fail(GRANT_NOT_AVAILABLE, 'grant status cannot release a reservation.');
  const cmd = baseCommand({ orgId, operationId, operationType: 'credit_release', actor: actorValue, now, reason, sourceType: 'usage_reservation', sourceId: reservationId });
  if (!expired) {
    return Object.freeze({
      journal: Object.freeze({ ...cmd, entries: Object.freeze([
        entry(state.accountId, state.grantId, units, amount, 'release_hold'),
        entry(state.accountId, state.grantId, -units, amount, 'release_offset'),
      ]) }),
      positionDeltas: Object.freeze([positionDelta(state.accountId, state.grantId, 0n, -units, amount)]),
    });
  }
  const sinkId = validateId(expiryClearingAccountId, 'expiryClearingAccountId');
  return Object.freeze({
    ...(expiryGrantPatch(grant) ? { grantPatch: expiryGrantPatch(grant) } : {}),
    journal: Object.freeze({ ...cmd, entries: Object.freeze([
      entry(state.accountId, state.grantId, -units, amount, 'expired_hold_release'),
      entry(sinkId, state.grantId, units, amount, 'expiry_clearing'),
    ]) }),
    positionDeltas: Object.freeze([positionDelta(state.accountId, state.grantId, -units, -units, amount)]),
  });
}

function planExpire({ orgId, operationId, grant, position, expiryClearingAccountId, actor: actorValue, now, reason }) {
  const state = snapshot(position, grant, orgId);
  if (grant.expiresAt === null || grant.expiresAt === undefined) fail(INVALID_CONTRACT, 'non-expiring grants cannot be expired.');
  if (timestamp(now, 'now') < timestamp(grant.expiresAt, 'grant.expiresAt')) fail(GRANT_NOT_AVAILABLE, 'grant has not reached expiry.');
  if (grant.status && !['active', 'expired'].includes(grant.status)) fail(GRANT_NOT_AVAILABLE, 'grant cannot expire from its current status.');
  if (state.accountPurpose && state.accountPurpose.endsWith('_clearing')) {
    const patch = expiryGrantPatch(grant);
    return Object.freeze({ ...(patch ? { grantPatch: patch } : {}), journal: null, positionDeltas: Object.freeze([]), noOp: true, heldForResolution: true });
  }
  const available = state.balance - state.reserved;
  const cmd = baseCommand({ orgId, operationId, operationType: 'credit_expire', actor: actorValue, now, reason, sourceType: 'credit_grant', sourceId: grant.id });
  if (available === 0n) {
    const patch = expiryGrantPatch(grant);
    return Object.freeze({ ...(patch ? { grantPatch: patch } : {}), journal: null, positionDeltas: Object.freeze([]), noOp: true });
  }
  const amount = { asset: state.amount.asset, scale: state.amount.scale, units: available.toString() };
  const sinkId = validateId(expiryClearingAccountId, 'expiryClearingAccountId');
  return Object.freeze({
    ...(expiryGrantPatch(grant) ? { grantPatch: expiryGrantPatch(grant) } : {}),
    journal: Object.freeze({ ...cmd, entries: Object.freeze([
      entry(state.accountId, state.grantId, -available, amount, 'credit_expiry'),
      entry(sinkId, state.grantId, available, amount, 'expiry_clearing'),
    ]) }),
    positionDeltas: Object.freeze([positionDelta(state.accountId, state.grantId, -available, 0n, amount)]),
  });
}

function planReverse({ orgId, operationId, originalJournal, grant, positions, actor: actorValue, now, reason, expiryClearingAccountId }) {
  if (!originalJournal || !Array.isArray(originalJournal.entries) || !originalJournal.entries.length) fail(INVALID_CONTRACT, 'original journal with entries is required.');
  if (originalJournal.orgId !== orgId) fail(FORBIDDEN, 'original journal belongs to another organization.');
  if (!['credit_issue', 'credit_transfer', 'credit_consume'].includes(originalJournal.operationType)) fail(INVALID_CONTRACT, 'this operation type cannot be reversed by this planner.');
  validateId(originalJournal.operationId, 'originalJournal.operationId');
  if (!grant || !grant.id) fail(INVALID_CONTRACT, 'grant snapshot is required for a credit journal reversal.');
  if (grant.expiresAt !== null && grant.expiresAt !== undefined && timestamp(now, 'now') >= timestamp(grant.expiresAt, 'grant.expiresAt')) fail(GRANT_EXPIRED, 'reversal cannot recreate credits after grant expiry.');
  if (!Array.isArray(positions)) fail(INVALID_CONTRACT, 'locked position snapshots are required for reversal.');
  if (grant && ['revoked', 'reversed'].includes(grant.status)) fail(GRANT_NOT_AVAILABLE, 'grant has already been revoked or reversed.');
  const byKey = new Map(positions.map((p) => [`${p.grantId}:${p.accountId}`, p]));
  const unitsByPosition = new Map();
  for (const e of originalJournal.entries) {
    const units = integer(e.amountUnits, 'originalJournal.entry.amountUnits');
    if (units === 0n) fail(INVALID_CONTRACT, 'original journal lines cannot be zero.');
    if (e.grantId) {
      if (!grant || e.grantId !== grant.id) fail(INVALID_CONTRACT, 'all grant lines must refer to the supplied grant.');
      if (grant.expiresAt !== null && grant.expiresAt !== undefined && timestamp(now, 'now') >= timestamp(grant.expiresAt, 'grant.expiresAt')) fail(GRANT_EXPIRED, 'reversal cannot recreate credits after grant expiry.');
      const clearingLine = CLEARING_ENTRY_TYPES.has(e.entryType);
      const current = clearingLine ? null : byKey.get(`${e.grantId}:${e.accountId}`);
      if (BigInt(e.amountUnits) > 0n && current) {
        const p = snapshot(current, grant, orgId);
        if (units > p.balance - p.reserved) fail(INSUFFICIENT_CREDITS, 'reversal cannot reclaim credits that were spent or held.');
      }
      if (current) {
        const key = JSON.stringify([e.grantId, e.accountId]);
        const prior = unitsByPosition.get(key);
        unitsByPosition.set(key, { grantId: e.grantId, accountId: e.accountId, delta: (prior ? prior.delta : 0n) - units, amount: { asset: e.asset, scale: e.scale } });
      }
    }
  }
  const cmd = baseCommand({ orgId, operationId, operationType: 'credit_reverse', actor: actorValue, now, reason, sourceType: 'billing_journal', sourceId: originalJournal.operationId });
  const reversedEntries = originalJournal.entries.map((e) => {
    const units = integer(e.amountUnits, 'originalJournal.entry.amountUnits');
    return entry(e.accountId, e.grantId || null, -units, { asset: e.asset, scale: e.scale, units: '0' }, 'journal_reversal');
  });
  const positionDeltas = Array.from(unitsByPosition.values(), ({ grantId, accountId, delta, amount }) => positionDelta(accountId, grantId, delta, 0n, amount));
  // `expiryClearingAccountId` is accepted for callers that share reversal
  // plumbing, but intentionally unused: expired grants are rejected above.
  void expiryClearingAccountId;
  const grantPatch = originalJournal.operationType === 'credit_issue'
    ? Object.freeze({ grantId: grant.id, status: 'reversed', expectedStatus: grant.status || 'active' })
    : undefined;
  return Object.freeze({ ...(grantPatch ? { grantPatch } : {}), journal: Object.freeze({ ...cmd, entries: Object.freeze(reversedEntries) }), positionDeltas: Object.freeze(positionDeltas) });
}

module.exports = Object.freeze({ planIssueGrant, planTransfer, planReserve, planConsume, planRelease, planExpire, planReverse });
