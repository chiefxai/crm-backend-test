'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { validateId } = require('../../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');
const { normalizeUsageEvent, sameUsageEvent } = require('../usageEvents');

function rowsOf(value) {
  const result = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(result) ? result : result?.rows || [];
}

function parseJson(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch (cause) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Stored usage pricing snapshot contains invalid JSON.', { retryable: true, details: { cause: cause.message } });
  }
}

function mapUsageEvent(row) {
  if (!row) return null;
  const pricingSnapshot = parseJson(row.pricing_snapshot_json);
  return normalizeUsageEvent({
    scope: { orgId: row.org_id, ownerType: 'workspace', ownerId: row.workspace_id },
    sourceType: row.source_type,
    sourceId: row.source_id,
    componentKey: row.component_key,
    revision: Number(row.revision),
    status: row.event_status,
    operationId: pricingSnapshot.operationId,
    periodId: row.period_id,
    quantity: { units: String(row.quantity_units), scale: Number(row.quantity_scale) },
    amount: { units: String(row.amount_units), asset: row.asset, scale: Number(row.scale) },
    pricingSnapshot,
    occurredAt: new Date(row.occurred_at).toISOString(),
    recordedAt: new Date(row.recorded_at).toISOString(),
  });
}

function createMysqlUsageEventRepository() {
  async function getByNaturalKey(tx, { orgId, sourceType, sourceId, componentKey, revision, forUpdate = false }) {
    assertTransactionContext(tx);
    validateId(orgId, 'orgId');
    if (tx.metadata?.orgId !== orgId) throw new TypeError('Usage event organization must match transaction organization.');
    const row = rowsOf(await tx.query(
      `SELECT id,org_id,workspace_id,period_id,source_type,source_id,component_key,revision,event_status,
              quantity_units,quantity_scale,amount_units,asset,scale,pricing_schema_version,pricing_snapshot_json,occurred_at,recorded_at
         FROM billing_usage_events
        WHERE org_id=? AND source_type=? AND source_id=? AND component_key=? AND revision=?${forUpdate ? ' FOR UPDATE' : ''}`,
      [orgId, sourceType, sourceId, componentKey, revision],
    ))[0];
    return mapUsageEvent(row);
  }

  async function record(tx, input) {
    assertTransactionContext(tx);
    const event = normalizeUsageEvent(input);
    if (tx.metadata?.orgId !== event.orgId) throw new TypeError('Usage event organization must match transaction organization.');
    const prior = await getByNaturalKey(tx, {
      orgId: event.orgId, sourceType: event.sourceType, sourceId: event.sourceId,
      componentKey: event.componentKey, revision: event.revision, forUpdate: true,
    });
    if (prior) {
      if (!sameUsageEvent(prior, event)) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Usage event revision already exists with different measured or priced content.', {
          details: { orgId: event.orgId, sourceType: event.sourceType, sourceId: event.sourceId, componentKey: event.componentKey, revision: event.revision },
        });
      }
      return Object.freeze({ ...prior, duplicate: true });
    }
    await tx.query(
      `INSERT INTO billing_usage_events
        (id,org_id,workspace_id,period_id,source_type,source_id,component_key,revision,event_status,quantity_units,quantity_scale,
         amount_units,asset,scale,pricing_schema_version,pricing_snapshot_json,occurred_at,recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [event.id, event.orgId, event.workspaceId, event.periodId, event.sourceType, event.sourceId, event.componentKey,
        event.revision, event.status, event.quantity.units, event.quantity.scale, event.amount.units, event.amount.asset,
        event.amount.scale, event.schemaVersion, JSON.stringify(event.pricingSnapshot), event.occurredAt, event.recordedAt],
    );
    return Object.freeze({ ...event, duplicate: false });
  }

  async function getById(tx, { orgId, eventId }) {
    assertTransactionContext(tx);
    validateId(orgId, 'orgId');
    validateId(eventId, 'eventId');
    if (tx.metadata?.orgId !== orgId) throw new TypeError('Usage event organization must match transaction organization.');
    const row = rowsOf(await tx.query(
      `SELECT id,org_id,workspace_id,period_id,source_type,source_id,component_key,revision,event_status,
              quantity_units,quantity_scale,amount_units,asset,scale,pricing_schema_version,pricing_snapshot_json,occurred_at,recorded_at
         FROM billing_usage_events WHERE org_id=? AND id=?`, [orgId, eventId],
    ))[0];
    return mapUsageEvent(row);
  }

  return Object.freeze({ record, getById, getByNaturalKey });
}

module.exports = { createMysqlUsageEventRepository, mapUsageEvent };
