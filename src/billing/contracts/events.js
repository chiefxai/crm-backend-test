'use strict';

const {
  CONTRACT_VERSION,
  objectAt,
  id,
  positiveInt,
  timestamp,
} = require('./validation');

function validateEventEnvelope(value) {
  objectAt(value, 'event', [
    'eventId', 'eventType', 'schemaVersion', 'operationId', 'orgId',
    'aggregateType', 'aggregateId', 'aggregateVersion', 'occurredAt',
    'correlationId', 'causationId', 'payload',
  ], [
    'eventId', 'eventType', 'schemaVersion', 'operationId', 'orgId',
    'aggregateType', 'aggregateId', 'aggregateVersion', 'occurredAt',
    'correlationId', 'payload',
  ]);
  const schemaVersion = positiveInt(value.schemaVersion, 'schemaVersion');
  if (schemaVersion !== CONTRACT_VERSION) throw new TypeError(`schemaVersion must be ${CONTRACT_VERSION} for the current event envelope.`);
  if (typeof value.eventType !== 'string' || !/^[A-Z][A-Za-z0-9]+\.v[1-9][0-9]*$/.test(value.eventType)) {
    throw new TypeError('eventType must use a versioned name such as PaymentConfirmed.v1.');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    throw new TypeError('payload must be a JSON object.');
  }
  const serialized = JSON.stringify(value.payload);
  if (serialized === undefined || serialized.length > 256 * 1024) throw new TypeError('payload must be JSON serializable and no larger than 256 KiB.');
  const eventVersion = Number(value.eventType.match(/\.v([1-9][0-9]*)$/)[1]);
  if (eventVersion !== schemaVersion) throw new TypeError('eventType version suffix must match schemaVersion.');
  const result = {
    eventId: id(value.eventId, 'eventId'),
    eventType: value.eventType,
    schemaVersion,
    operationId: id(value.operationId, 'operationId'),
    orgId: id(value.orgId, 'orgId'),
    aggregateType: value.aggregateType,
    aggregateId: id(value.aggregateId, 'aggregateId'),
    aggregateVersion: positiveInt(value.aggregateVersion, 'aggregateVersion'),
    occurredAt: timestamp(value.occurredAt, 'occurredAt'),
    correlationId: id(value.correlationId, 'correlationId'),
    payload: Object.freeze({ ...value.payload }),
  };
  if (typeof result.aggregateType !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(result.aggregateType)) {
    throw new TypeError('aggregateType must be a simple type name.');
  }
  if (value.causationId !== undefined) result.causationId = id(value.causationId, 'causationId');
  return Object.freeze(result);
}

module.exports = { validateEventEnvelope };
