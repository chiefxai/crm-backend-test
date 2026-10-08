'use strict';

const crypto = require('node:crypto');
const { createEstimatedUsageEvent } = require('./rating');

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new TypeError(`${name} is required.`);
  return value;
}

function objectSnapshot(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function operationId(prefix, sourceId) {
  const digest = crypto.createHash('sha256').update(String(sourceId)).digest('hex').slice(0, 32);
  return `${prefix}-${digest}`;
}

function createLegacyCallUsageEvents({ record, creditAsset, creditScale = 0, recordedAt }) {
  if (!record || typeof record !== 'object') throw new TypeError('call billing record is required.');
  const orgId = required(record.orgId || record.org_id, 'record.orgId');
  const workspaceId = required(record.workspaceId || record.workspace_id, 'record.workspaceId');
  const callId = required(record.callId || record.call_id, 'record.callId');
  const occurredAt = required(record.occurredAt || record.createdAt || record.created_at, 'record.occurredAt');
  const durationSeconds = Math.max(0, Number(record.durationSeconds ?? record.duration_seconds) || 0);
  const durationUnits = String(Math.round(durationSeconds * 1000));
  const snapshot = objectSnapshot(record.snapshot);
  const candidates = [
    {
      key: 'telephony.provider',
      cost: record.providerCostInr ?? record.provider_cost_inr,
      detail: snapshot.providerCostDetail || {
        provider: record.telephonyProvider || record.telephony_provider,
        pricingVersion: record.providerPricingVersion || record.provider_pricing_version,
        rateAmount: record.providerRateAmount ?? record.provider_rate_amount,
        rateUnit: record.providerRateUnit || record.provider_rate_unit,
      },
    },
    { key: 'telephony.number', cost: record.phoneNumberCostInr ?? record.phone_number_cost_inr, detail: snapshot.phoneNumberCostDetail || null },
  ].filter((item) => Number(item.cost) > 0);

  return candidates.map((item) => createEstimatedUsageEvent({
    event: {
      scope: { orgId, ownerType: 'workspace', ownerId: workspaceId },
      workspaceId,
      operationId: operationId('call-usage', callId),
      sourceType: 'call_billing_record',
      sourceId: callId,
      componentKey: item.key,
      revision: Number(record.revision || 1),
      occurredAt,
      recordedAt: recordedAt || occurredAt,
      periodId: record.periodId || record.period_id || undefined,
    },
    quantity: { units: durationUnits, scale: 3 },
    creditAsset,
    creditScale,
    estimateSnapshot: {
      schemaVersion: 1,
      sourceCurrency: 'INR',
      estimatedAmountInr: String(item.cost),
      detail: item.detail,
      legacyBillingMethod: record.billingMethod || record.billing_method || null,
    },
  }));
}

function createLegacyAiSessionUsageEvent({ session, creditAsset, creditScale = 0, recordedAt }) {
  if (!session || typeof session !== 'object') throw new TypeError('AI session usage record is required.');
  const orgId = required(session.orgId || session.org_id, 'session.orgId');
  const workspaceId = required(session.workspaceId || session.workspace_id, 'session.workspaceId');
  const sessionId = required(session.id, 'session.id');
  if (session.status === 'in_progress') throw new TypeError('AI session usage must be finalized before it can be snapshotted.');
  const occurredAt = required(session.sessionEndedAt || session.session_ended_at || session.sessionStartedAt || session.session_started_at, 'session occurredAt');
  const cost = session.platformTotalCostInr ?? session.platform_total_cost_inr;
  const costProviderKey = session.platformCostProviderKey || session.platform_cost_provider_key || 'gemini';
  const pricingMode = session.platformPricingMode || session.platform_pricing_mode || 'time';
  const useTokens = pricingMode === 'token';
  const quantityUnits = useTokens
    ? String(Math.max(0, Number(session.totalTokens ?? session.total_tokens) || 0))
    : String(Math.max(0, Number(session.durationSeconds ?? session.duration_seconds) || 0) * 1000);
  const quantityScale = useTokens ? 0 : 3;
  return createEstimatedUsageEvent({
    event: {
      scope: { orgId, ownerType: 'workspace', ownerId: workspaceId },
      workspaceId,
      operationId: operationId('ai-usage', sessionId),
      sourceType: 'ai_session_usage',
      sourceId: sessionId,
      componentKey: `ai.${costProviderKey}`,
      revision: Number(session.revision || 1),
      occurredAt,
      recordedAt: recordedAt || occurredAt,
      periodId: session.periodId || session.period_id || undefined,
    },
    quantity: { units: quantityUnits, scale: quantityScale },
    creditAsset,
    creditScale,
    estimateSnapshot: {
      schemaVersion: 1,
      sourceCurrency: 'INR',
      estimatedAmountInr: String(cost ?? 0),
      measuredUnit: useTokens ? 'token' : 'second',
      provider: session.provider || null,
      model: session.model || null,
      costProviderKey,
      pricingMode,
      pricingVersion: session.pricingVersion || session.pricing_version || null,
      ratePer1k: session.platformRatePer1k ?? session.platform_rate_per_1k ?? null,
      tokenUnit: session.platformTokenUnit ?? session.platform_token_unit ?? null,
      timeRateAmount: session.platformTimeRateAmount ?? session.platform_time_rate_amount ?? null,
      timeUnit: session.platformTimeUnit || session.platform_time_unit || null,
      taxPercent: session.platformTaxPercent ?? session.platform_tax_percent ?? null,
      status: session.status || null,
    },
  });
}

module.exports = { createLegacyCallUsageEvents, createLegacyAiSessionUsageEvent };
