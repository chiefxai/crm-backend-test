'use strict';

const { assertTransactionContext } = require('../../kernel/transactionContext');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');

const MAX_ID_LENGTH = 191;
const MAX_CONSUMER_KEY_LENGTH = 128;

function invalid(message, details) {
  return new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, message, { details });
}

function requiredText(value, field, max = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw invalid(`${field} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

function queryResult(result) {
  if (!result || !Array.isArray(result.rows)) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Billing SQL adapter returned an invalid query result.', { retryable: true });
  }
  return result;
}

function isDuplicateKey(error) {
  return Boolean(error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062 || error.code === '23505'));
}

async function lockExisting(tx, { orgId, consumerKey, eventId }) {
  const result = queryResult(await tx.query(
    `SELECT id,org_id,consumer_key,event_id,event_type,status,attempt_count,first_seen_at,processed_at,result_reference
       FROM billing_consumer_inbox
      WHERE org_id=? AND consumer_key=? AND event_id=?
      FOR UPDATE`,
    [orgId, consumerKey, eventId],
  ));
  return result.rows[0] || null;
}

/**
 * Run a consumer's database effects once per (org, consumer, event), in tx.
 * External/provider effects are outside this guarantee; enqueue an outbox
 * message inside tx for those and make delivery idempotent separately.
 */
async function process(tx, { id, orgId, consumerKey, eventId, eventType, now, resultReference = null } = {}, handler) {
  assertTransactionContext(tx);
  id = requiredText(id, 'id');
  orgId = requiredText(orgId, 'orgId');
  consumerKey = requiredText(consumerKey, 'consumerKey', MAX_CONSUMER_KEY_LENGTH);
  eventId = requiredText(eventId, 'eventId');
  eventType = requiredText(eventType, 'eventType', MAX_CONSUMER_KEY_LENGTH);
  if (now === undefined || now === null) throw invalid('now is required.');
  if (resultReference !== null) resultReference = requiredText(resultReference, 'resultReference');
  if (typeof handler !== 'function') throw invalid('A transaction-bound consumer handler is required.');

  let row = await lockExisting(tx, { orgId, consumerKey, eventId });
  if (row?.status === 'processed') {
    return { processed: false, duplicate: true, resultReference: row.result_reference ?? null };
  }

  if (!row) {
    try {
      queryResult(await tx.query(
        `INSERT INTO billing_consumer_inbox
           (id,org_id,consumer_key,event_id,event_type,status,attempt_count,first_seen_at,processed_at,last_error_code,last_error_at,result_reference)
         VALUES (?,?,?,?,?,'received',0,?,NULL,NULL,NULL,NULL)`,
        [id, orgId, consumerKey, eventId, eventType, now],
      ));
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // A concurrent consumer may have won the unique-key race. Lock its row
      // and apply the same processed/retry decision while still in this tx.
      row = await lockExisting(tx, { orgId, consumerKey, eventId });
      if (!row) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY, 'Inbox event raced with another consumer; retry the transaction.', { retryable: true });
      if (row.status === 'processed') {
        return { processed: false, duplicate: true, resultReference: row.result_reference ?? null };
      }
    }
  }

  const attemptUpdate = queryResult(await tx.query(
    `UPDATE billing_consumer_inbox
        SET status='received',attempt_count=attempt_count+1,last_error_code=NULL,last_error_at=NULL
      WHERE org_id=? AND consumer_key=? AND event_id=? AND status<>'processed'`,
    [orgId, consumerKey, eventId],
  ));
  const affectedRows = attemptUpdate.affectedRows ?? attemptUpdate.rowCount;
  if (affectedRows !== undefined && affectedRows !== 1) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY, 'Inbox event could not be claimed for processing.', { retryable: true });
  }

  const result = await handler(tx);
  const completed = queryResult(await tx.query(
    `UPDATE billing_consumer_inbox
        SET status='processed',processed_at=?,result_reference=?
      WHERE org_id=? AND consumer_key=? AND event_id=? AND status='received'`,
    [now, resultReference, orgId, consumerKey, eventId],
  ));
  const completedRows = completed.affectedRows ?? completed.rowCount;
  if (completedRows !== undefined && completedRows !== 1) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Inbox event completion was lost.', {
      details: { orgId, consumerKey, eventId, affectedRows: completedRows },
    });
  }
  return { processed: true, duplicate: false, resultReference, result };
}

module.exports = { process, lockExisting, isDuplicateKey };
