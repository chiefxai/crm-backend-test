'use strict';

const crypto = require('node:crypto');
const { workspaceScope } = require('../../kernel/scope');
const { createPayableUsageEvent } = require('./rating');

function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function operationId(prefix, value) { return `${prefix}-${digest(value).slice(0, 40)}`; }
function fingerprint(value) { return `sha256:${digest(JSON.stringify(value))}`; }
function systemContext(orgId, operation, payload) {
  return {
    schemaVersion: 1,
    operationId: operationId('provider-billing', operation),
    requestFingerprint: fingerprint(payload),
    actor: { type: 'system', id: 'provider-usage-adapter' },
  };
}
function validDuration(value, maxSeconds) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > maxSeconds) {
    const error = new RangeError(`Measured provider duration must be between 0 and ${maxSeconds} seconds.`);
    error.code = 'PROVIDER_DURATION_OUT_OF_RANGE';
    throw error;
  }
  return seconds;
}

/**
 * Provider-facing boundary. It never derives credits from INR estimates. A
 * provider must supply an explicit purchased rate and measured quantity before
 * this adapter records a payable event. The adapter is deliberately opt-in.
 */
function createProviderUsageLifecycle({ reservationService, settlementService, usageEventRepository,
  unitOfWork, idSource, clock, authorize, creditAsset, creditScale = 0, maxDurationSeconds = 24 * 60 * 60,
  enforcementEnabled = false } = {}) {
  if (typeof enforcementEnabled !== 'boolean') throw new TypeError('enforcementEnabled must be a boolean.');
  if (!Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 7 * 24 * 60 * 60) throw new TypeError('maxDurationSeconds must be from 1 to 604800.');
  if (enforcementEnabled) {
    if (typeof reservationService?.reserveUsage !== 'function' || typeof reservationService?.extendUsage !== 'function'
      || typeof reservationService?.releaseUsage !== 'function' || typeof settlementService?.settle !== 'function'
      || typeof usageEventRepository?.record !== 'function' || typeof unitOfWork?.runFinancial !== 'function'
      || typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function' || typeof authorize !== 'function'
      || typeof creditAsset !== 'string' || !creditAsset) {
      throw new TypeError('Enabled provider usage requires reservation, settlement, event, transaction, identity, authorization, and credit-asset dependencies.');
    }
  }

  function assertEnabled() {
    if (!enforcementEnabled) {
      const error = new Error('Provider credit enforcement is disabled until a versioned purchased credit rate and rollout approval are configured.');
      error.code = 'PROVIDER_CREDIT_ENFORCEMENT_DISABLED';
      error.statusCode = 503;
      throw error;
    }
  }

  async function reserve({ orgId, workspaceId, usageOperationId: usageId, service, estimatedAmount, pricingSnapshot, validUntil, policyVersion, sourceRevision = '0' }) {
    assertEnabled();
    await authorize({ orgId, workspaceId, action: 'usage.reserve', service });
    const request = { orgId, workspaceId, usageId, service, estimatedAmount, pricingSnapshot, validUntil, policyVersion, sourceRevision };
    return reservationService.reserveUsage({ command: {
      schemaVersion: 1, orgId, scope: workspaceScope(orgId, workspaceId), usageOperationId: usageId,
      sourceRevision, service, estimatedAmount, pricingSnapshot, validUntil, policyVersion,
    }, trustedContext: systemContext(orgId, `reserve:${usageId}:${sourceRevision}`, request) });
  }

  async function recordAndSettle({ orgId, workspaceId, reservationId, reservationVersion, sourceType,
    sourceId, componentKey, revision = 1, periodId, operation, quantity, durationSeconds, unitQuantity, unitRate,
    rateVersion, rateSnapshot, rounding = 'half_up', occurredAt, finalize = false }) {
    assertEnabled();
    await authorize({ orgId, workspaceId, action: 'usage.settle', sourceType, sourceId, componentKey });
    if (durationSeconds !== undefined) validDuration(durationSeconds, maxDurationSeconds);
    const now = clock.now();
    const operationKey = operation || `${sourceType}:${sourceId}:${componentKey}:${revision}`;
    const event = createPayableUsageEvent({
      event: { scope: workspaceScope(orgId, workspaceId), workspaceId, operationId: operationId('usage', operationKey),
        sourceType, sourceId, componentKey, revision, periodId, occurredAt, recordedAt: now },
      quantity, unitQuantity, unitRate, rateVersion, rateSnapshot, rounding,
    });
    const recordContext = systemContext(orgId, `event:${event.id}`, event);
    const stored = await unitOfWork.runFinancial({ orgId, operationId: recordContext.operationId,
      requestFingerprint: recordContext.requestFingerprint, callback: (tx) => usageEventRepository.record(tx, event) });
    const settlementContext = systemContext(orgId, `settle:${event.id}`, { eventId: event.id, reservationId, reservationVersion, finalize });
    return settlementService.settle({ command: { schemaVersion: 1, orgId, workspaceId, reservationId,
      usageEventId: event.id, expectedVersion: reservationVersion, finalize }, trustedContext: settlementContext,
      event: stored });
  }

  async function extend({ orgId, workspaceId, reservationId, reservationVersion, additionalAmount,
    pricingSnapshot, validUntil }) {
    assertEnabled();
    await authorize({ orgId, workspaceId, action: 'usage.extend', reservationId });
    const request = { orgId, workspaceId, reservationId, reservationVersion, additionalAmount, pricingSnapshot, validUntil };
    return reservationService.extendUsage({ command: { schemaVersion: 1, orgId, workspaceId, reservationId,
      additionalAmount, pricingSnapshot, validUntil, expectedVersion: reservationVersion },
      trustedContext: systemContext(orgId, `extend:${reservationId}:${reservationVersion}`, request) });
  }

  async function release({ orgId, workspaceId, reservationId, reservationVersion, providerState }) {
    assertEnabled();
    if (providerState !== 'no_billable_work') {
      const error = new Error('Provider reservation can only be released after reconciliation confirms no billable work.');
      error.code = 'PROVIDER_RECONCILIATION_REQUIRED';
      throw error;
    }
    await authorize({ orgId, workspaceId, action: 'usage.release', reservationId });
    const request = { orgId, workspaceId, reservationId, reservationVersion, providerState };
    return reservationService.releaseUsage({ command: { schemaVersion: 1, orgId, workspaceId, reservationId,
      expectedVersion: reservationVersion }, trustedContext: systemContext(orgId, `release:${reservationId}:${reservationVersion}`, request) });
  }

  return Object.freeze({ enforcementEnabled, maxDurationSeconds, creditAsset, creditScale, validDuration,
    reserve, recordAndSettle, extend, release });
}

module.exports = { createProviderUsageLifecycle, validDuration };
