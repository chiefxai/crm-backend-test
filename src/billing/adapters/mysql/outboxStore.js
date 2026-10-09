'use strict';

const crypto = require('node:crypto');
const { assertTransactionContext } = require('../../kernel/transactionContext');
const { validateEventEnvelope } = require('../../contracts/events');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');
const { validateId } = require('../../kernel/scope');

const MAX_BATCH_SIZE = 500;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;

function invalid(message, details) {
  return new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, message, { details });
}

function queryRows(result) {
  if (Array.isArray(result)) return Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(result?.rows) ? result.rows : [];
}

function affectedRows(result) {
  if (Array.isArray(result)) return Number(result[0]?.affectedRows ?? result[0]?.rowCount ?? 0);
  return Number(result?.affectedRows ?? result?.rowCount ?? 0);
}

function queryResult(result) {
  if (!Array.isArray(result) && !Array.isArray(result?.rows) && result?.affectedRows === undefined && result?.rowCount === undefined) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Billing outbox SQL adapter returned an invalid query result.', { retryable: true });
  }
  return result;
}

function boundedInt(value, field, { min = 1, max = MAX_BATCH_SIZE } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${field} must be an integer from ${min} to ${max}.`);
  return value;
}

function requiredText(value, field, max = 191) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw invalid(`${field} must be a non-empty string of at most ${max} characters.`);
  return value;
}

function fencingValue(value) {
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || BigInt(text) > 18446744073709551615n) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Outbox fencing token is outside the supported unsigned 64-bit range.', { retryable: true });
  }
  return text;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadText(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch (error) { throw invalid('Outbox payload must be JSON serializable.', { cause: error.message }); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_PAYLOAD_BYTES) throw invalid('Outbox payload must be JSON serializable and no larger than 256 KiB.');
  return encoded;
}

function deterministicPartitionKey(event) {
  return crypto.createHash('sha256').update(`${event.orgId}\0${event.aggregateType}\0${event.aggregateId}`).digest('hex').slice(0, 64);
}

function mapEvent(row) {
  let envelope;
  try { envelope = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json; }
  catch (error) { throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Outbox event payload contains invalid JSON.', { retryable: true, details: { cause: error.message } }); }
  if (!envelope || envelope.eventId !== row.id || typeof envelope.payload !== 'object') {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Outbox event envelope is invalid.', { retryable: true });
  }
  return {
    ...envelope,
    partitionKey: row.partition_key,
    attempts: Number(row.attempts),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    fencingToken: fencingValue(row.fencing_token),
    leaseExpiresAt: row.lease_expires_at,
  };
}

function normalizeEvent(input, txOrgId) {
  let event;
  try { event = validateEventEnvelope(input); }
  catch (error) { throw invalid(error.message, { path: error.path, cause: error.cause?.message }); }
  if (event.orgId !== txOrgId) throw invalid('Outbox event orgId must match the transaction organization.');
  const encodedPayload = payloadText(event);
  const partitionKey = deterministicPartitionKey(event);
  const representation = canonical(event);
  return { event, encodedPayload, partitionKey, representation };
}

function isDuplicateKey(error) { return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062 || error?.code === '23505'; }

function validateAllowedEventTypes(input) {
  if (input === undefined) return null;
  if (!Array.isArray(input) || input.length === 0 || input.length > 50 ||
    input.some(type => typeof type !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(type)) ||
    new Set(input).size !== input.length) {
    throw new TypeError('allowedEventTypes must be a non-empty unique set of up to 50 valid event types.');
  }
  return input;
}

function createMysqlOutboxStore({ pool, clock, tokenSource, random = Math.random }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Billing MySQL outbox requires a pool with connect().');
  if (typeof tokenSource?.newId !== 'function') throw new TypeError('Billing MySQL outbox requires tokenSource.newId().');
  if (typeof clock?.now !== 'function') throw new TypeError('Billing MySQL outbox requires clock.now().');

  async function enqueue(tx, { events } = {}) {
    assertTransactionContext(tx);
    if (!Array.isArray(events) || events.length < 1 || events.length > MAX_BATCH_SIZE) throw invalid(`events must contain 1 to ${MAX_BATCH_SIZE} events.`);
    const txOrgId = tx.metadata?.orgId;
    validateId(txOrgId, 'transaction.orgId');
    const enqueued = [];
    let batchBytes = 0;
    for (const input of events) {
      const item = normalizeEvent(input, txOrgId);
      batchBytes += Buffer.byteLength(item.encodedPayload, 'utf8');
      if (batchBytes > MAX_BATCH_BYTES) throw invalid(`Serialized event batch must not exceed ${MAX_BATCH_BYTES} bytes.`);
      const { event } = item;
      const id = event.eventId;
      const now = clock.now();
      try {
        queryResult(await tx.query(
          `INSERT INTO billing_outbox
             (id,org_id,event_key,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,partition_key,
              correlation_id,causation_id,payload_json,status,available_at,attempts,lease_owner,lease_token,fencing_token,
              lease_expires_at,completed_at,last_error_code,last_error_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,0,NULL,NULL,0,NULL,NULL,NULL,NULL,?,?)`,
          [id, event.orgId, event.eventId, event.eventType, event.schemaVersion, event.aggregateType, event.aggregateId,
            event.aggregateVersion, item.partitionKey, event.correlationId, event.causationId || null,
            item.encodedPayload, now, now, now],
        ));
        enqueued.push({ eventId: id, orgId: event.orgId, status: 'pending', duplicate: false });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const existingResult = queryResult(await tx.query(
          `SELECT id,org_id,event_key,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,
                  correlation_id,causation_id,payload_json,created_at
             FROM billing_outbox WHERE org_id=? AND event_key=? FOR UPDATE`,
          [event.orgId, event.eventId],
        ));
        const existing = queryRows(existingResult)[0];
        let storedEnvelope;
        try { storedEnvelope = typeof existing?.payload_json === 'string' ? JSON.parse(existing.payload_json) : existing?.payload_json; }
        catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Stored outbox event contains invalid JSON.', { retryable: true, details: { cause: cause.message } }); }
        const storedRepresentation = existing && canonical(storedEnvelope);
        if (!existing || storedRepresentation !== item.representation) {
          throw new BillingDomainError(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Outbox event ID was reused with different event contents.', { details: { orgId: event.orgId, eventId: event.eventId } });
        }
        enqueued.push({ eventId: event.eventId, orgId: event.orgId, status: 'existing', duplicate: true });
      }
    }
    return enqueued;
  }

  async function listReadyOrganizations({ limit = 100, afterOrgId, allowedEventTypes } = {}) {
    limit = boundedInt(limit, 'limit');
    if (afterOrgId !== undefined) afterOrgId = validateId(afterOrgId, 'afterOrgId');
    const eventTypes = validateAllowedEventTypes(allowedEventTypes);
    const connection = await pool.connect();
    try {
      const cursorClause = afterOrgId ? 'AND org_id>?' : '';
      const typeClause = eventTypes ? `AND event_type IN (${eventTypes.map(() => '?').join(',')})` : '';
      const params = afterOrgId
        ? [clock.now(), clock.now(), ...eventTypes || [], afterOrgId, limit]
        : [clock.now(), clock.now(), ...eventTypes || [], limit];
      const result = queryResult(await connection.query(
        `SELECT org_id, MIN(available_at) AS oldest_available_at
           FROM billing_outbox
          WHERE ((status='pending' AND available_at<=?)
             OR (status='leased' AND lease_expires_at<=?))
             ${typeClause} ${cursorClause}
          GROUP BY org_id
          ORDER BY org_id
          LIMIT ?`,
        params,
      ));
      return queryRows(result).map((row) => row.org_id);
    } finally { connection.release(); }
  }

  async function claimBatch({ orgId, workerId, limit = 50, leaseMs = 30000, allowedEventTypes } = {}) {
    orgId = orgId === undefined ? undefined : validateId(orgId, 'orgId');
    workerId = requiredText(workerId, 'workerId');
    limit = boundedInt(limit, 'limit');
    boundedInt(leaseMs, 'leaseMs', { min: 100, max: 24 * 60 * 60 * 1000 });
    const eventTypes = validateAllowedEventTypes(allowedEventTypes);
    const connection = await pool.connect();
    let started = false;
    try {
      await connection.query('START TRANSACTION');
      started = true;
      const now = clock.now();
      const whereOrg = orgId ? 'AND org_id=?' : '';
      const whereType = eventTypes ? `AND event_type IN (${eventTypes.map(() => '?').join(',')})` : '';
      const params = orgId ? [now, now, orgId, ...eventTypes || [], limit] : [now, now, ...eventTypes || [], limit];
      const selectedResult = queryResult(await connection.query(
        `SELECT id,org_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,partition_key,
                correlation_id,causation_id,payload_json,status,attempts,lease_token,fencing_token,lease_expires_at,created_at
           FROM billing_outbox
          WHERE ((status='pending' AND available_at<=?) OR (status='leased' AND lease_expires_at<=?)) ${whereOrg} ${whereType}
          ORDER BY available_at,partition_key,id
          LIMIT ? FOR UPDATE SKIP LOCKED`,
        params,
      ));
      const claimed = [];
      for (const row of queryRows(selectedResult)) {
        const leaseToken = tokenSource.newId('billing-outbox-lease');
        const fencingToken = (BigInt(fencingValue(row.fencing_token)) + 1n).toString();
        if (BigInt(fencingToken) > 18446744073709551615n) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Outbox fencing token is outside the supported unsigned 64-bit range.', { retryable: true });
        const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMs);
        const updated = queryResult(await connection.query(
          `UPDATE billing_outbox
              SET status='leased',attempts=attempts+1,lease_owner=?,lease_token=?,fencing_token=?,lease_expires_at=?,updated_at=?
            WHERE org_id=? AND id=? AND fencing_token=?`,
          [workerId, leaseToken, fencingToken, leaseExpiresAt, now, row.org_id, row.id, row.fencing_token],
        ));
        if (affectedRows(updated) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY, 'Outbox claim lost its row lock before lease assignment.', { retryable: true });
        claimed.push(mapEvent({ ...row, status: 'leased', attempts: Number(row.attempts) + 1, lease_owner: workerId, lease_token: leaseToken, fencing_token: fencingToken, lease_expires_at: leaseExpiresAt }));
      }
      await connection.query('COMMIT');
      started = false;
      return claimed;
    } catch (error) {
      if (started) { try { await connection.query('ROLLBACK'); } catch (_) { /* retain original error */ } }
      throw error;
    } finally { connection.release(); }
  }

  function validateClaimIdentity({ eventId, workerId, leaseToken, fencingToken }) {
    const normalizedFencingToken = fencingValue(fencingToken);
    if (normalizedFencingToken === '0') throw invalid('fencingToken must be greater than zero.');
    return {
      eventId: validateId(eventId, 'eventId'),
      workerId: requiredText(workerId, 'workerId'),
      leaseToken: requiredText(leaseToken, 'leaseToken'),
      fencingToken: normalizedFencingToken,
    };
  }

  async function ack(claim) {
    const identity = validateClaimIdentity(claim || {});
    const now = clock.now();
    const connection = await pool.connect();
    try {
      const result = queryResult(await connection.query(
        `UPDATE billing_outbox SET status='completed',completed_at=?,updated_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
          WHERE id=? AND status='leased' AND lease_owner=? AND lease_token=? AND fencing_token=? AND lease_expires_at>?`,
        [now, now, identity.eventId, identity.workerId, identity.leaseToken, identity.fencingToken, now],
      ));
      if (affectedRows(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Outbox lease is stale or no longer owned by this worker.', { details: { eventId: identity.eventId } });
      return { eventId: identity.eventId, status: 'completed' };
    } finally { connection.release(); }
  }

  async function fail(claim, { errorCode = 'DELIVERY_FAILED', maxAttempts = 12, baseDelayMs = 1000, maxDelayMs = 3600000 } = {}) {
    const identity = validateClaimIdentity(claim || {});
    requiredText(errorCode, 'errorCode', 96);
    boundedInt(maxAttempts, 'maxAttempts', { min: 1, max: 1000 });
    boundedInt(baseDelayMs, 'baseDelayMs', { min: 1, max: 24 * 60 * 60 * 1000 });
    boundedInt(maxDelayMs, 'maxDelayMs', { min: 1, max: 7 * 24 * 60 * 60 * 1000 });
    const now = clock.now();
    const connection = await pool.connect();
    let started = false;
    try {
      await connection.query('START TRANSACTION');
      started = true;
      const selected = queryResult(await connection.query(
        `SELECT attempts FROM billing_outbox WHERE id=? AND status='leased' AND lease_owner=? AND lease_token=? AND fencing_token=? AND lease_expires_at>? FOR UPDATE`,
        [identity.eventId, identity.workerId, identity.leaseToken, identity.fencingToken, now],
      ));
      const row = queryRows(selected)[0];
      if (!row) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Outbox lease is stale or no longer owned by this worker.', { details: { eventId: identity.eventId } });
      const attempts = Number(row.attempts);
      const dead = attempts >= maxAttempts;
      const exponent = Math.min(30, Math.max(0, attempts - 1));
      const backoff = Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
      const jitter = Math.floor(backoff * (0.5 + Math.max(0, Math.min(0.999999, random())) * 0.5));
      const availableAt = new Date(new Date(now).getTime() + jitter);
      const result = queryResult(await connection.query(
        `UPDATE billing_outbox
            SET status=?,available_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=?,last_error_at=?,updated_at=?
          WHERE id=? AND status='leased' AND lease_owner=? AND lease_token=? AND fencing_token=? AND lease_expires_at>?`,
        [dead ? 'dead_letter' : 'pending', availableAt, errorCode, now, now, identity.eventId, identity.workerId, identity.leaseToken, identity.fencingToken, now],
      ));
      if (affectedRows(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Outbox lease changed while recording delivery failure.', { details: { eventId: identity.eventId } });
      await connection.query('COMMIT');
      started = false;
      return { eventId: identity.eventId, status: dead ? 'dead_letter' : 'pending', attempts, availableAt: dead ? null : availableAt };
    } catch (error) {
      if (started) { try { await connection.query('ROLLBACK'); } catch (_) { /* retain original error */ } }
      throw error;
    } finally { connection.release(); }
  }

  return Object.freeze({ enqueue, listReadyOrganizations, claimBatch, ack, fail });
}

module.exports = { validateAllowedEventTypes, createMysqlOutboxStore, MAX_BATCH_SIZE, MAX_PAYLOAD_BYTES, MAX_BATCH_BYTES, deterministicPartitionKey };
