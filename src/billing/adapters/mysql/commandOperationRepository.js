'use strict';

const { assertTransactionContext } = require('../../kernel/transactionContext');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');

const FINGERPRINT_PREFIX = 'sha256:';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ID_LENGTH = 191;

function invalid(message, details) {
  return new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, message, { details });
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ID_LENGTH) {
    throw invalid(`${field} must be a non-empty string of at most ${MAX_ID_LENGTH} characters.`);
  }
  return value;
}

function digestFromFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint.startsWith(FINGERPRINT_PREFIX)) {
    throw invalid('requestFingerprint must use the sha256:<digest> format.');
  }
  const digest = fingerprint.slice(FINGERPRINT_PREFIX.length);
  if (!DIGEST_PATTERN.test(digest)) throw invalid('requestFingerprint must contain a lowercase SHA-256 digest.');
  return digest;
}

function encodeResult(result) {
  let encoded;
  try {
    encoded = JSON.stringify(result);
  } catch (error) {
    throw invalid('Command result must be JSON serializable.', { cause: error.message });
  }
  if (encoded === undefined) throw invalid('Command result must be JSON serializable.');
  return encoded;
}

function decodeResult(value) {
  if (value === null || value === undefined) return null;
  try {
    // mysql drivers may return decoded JSON values or the raw JSON text.
    if (typeof value === 'string') return JSON.parse(value);
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw invalid('Stored command result contains invalid JSON.', { cause: error.message });
  }
}

function normalizeRow(row) {
  if (!row) return null;
  const digest = row.request_fingerprint;
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    throw invalid('Stored command fingerprint is invalid.');
  }
  return {
    id: row.id,
    orgId: row.org_id,
    operationId: row.idempotency_key,
    requestFingerprint: `${FINGERPRINT_PREFIX}${digest}`,
    status: row.status,
    result: decodeResult(row.result_json),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function assertQueryResult(result) {
  if (!result || !Array.isArray(result.rows)) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Billing SQL adapter returned an invalid query result.', { retryable: true });
  }
  return result;
}

function isDuplicateKey(error) {
  return Boolean(error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062 || error.code === '23505'));
}

async function findForUpdate(tx, { orgId, operationId }) {
  assertTransactionContext(tx);
  orgId = requiredText(orgId, 'orgId');
  operationId = requiredText(operationId, 'operationId');
  const result = assertQueryResult(await tx.query(
    `SELECT id,org_id,idempotency_key,request_fingerprint,status,result_json,version,created_at,updated_at,completed_at
       FROM billing_command_operations
      WHERE org_id=? AND idempotency_key=?
      FOR UPDATE`,
    [orgId, operationId],
  ));
  return result.rows.length ? normalizeRow(result.rows[0]) : null;
}

async function start(tx, { id, orgId, operationId, requestFingerprint, now }) {
  assertTransactionContext(tx);
  id = requiredText(id, 'id');
  orgId = requiredText(orgId, 'orgId');
  operationId = requiredText(operationId, 'operationId');
  const digest = digestFromFingerprint(requestFingerprint);
  if (now === undefined || now === null) throw invalid('now is required.');
  try {
    assertQueryResult(await tx.query(
      `INSERT INTO billing_command_operations
         (id,org_id,operation_type,idempotency_key,request_fingerprint,status,result_json,version,created_at,updated_at,completed_at)
       VALUES (?,?,?, ?,?,'processing',NULL,1,?,?,NULL)`,
      [id, orgId, 'billing.command', operationId, digest, now, now],
    ));
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'A command already uses this organization idempotency key.', { details: { orgId, operationId } });
    }
    throw error;
  }
  return {
    id,
    orgId,
    operationId,
    requestFingerprint,
    status: 'processing',
    result: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

async function complete(tx, { orgId, operationId, result, now }) {
  assertTransactionContext(tx);
  orgId = requiredText(orgId, 'orgId');
  operationId = requiredText(operationId, 'operationId');
  if (now === undefined || now === null) throw invalid('now is required.');
  const encoded = encodeResult(result);
  const queryResult = assertQueryResult(await tx.query(
    `UPDATE billing_command_operations
        SET status='completed',result_json=?,updated_at=?,completed_at=?,version=version+1
      WHERE org_id=? AND idempotency_key=? AND status='processing'`,
    [encoded, now, now, orgId, operationId],
  ));
  const affectedRows = queryResult && (queryResult.affectedRows ?? queryResult.rowCount);
  if (affectedRows !== 1) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Command operation is missing or is no longer processing.', {
      details: { orgId, operationId, affectedRows: affectedRows ?? null },
    });
  }
  return { orgId, operationId, status: 'completed', result: decodeResult(encoded), completedAt: now };
}

module.exports = { findForUpdate, start, complete };
