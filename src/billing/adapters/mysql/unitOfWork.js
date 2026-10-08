'use strict';

const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');
const { validateId } = require('../../kernel/scope');
const { expectedVersions: validateExpectedVersions } = require('../../contracts/validation');
const { createTransactionContext } = require('../../kernel/transactionContext');

const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_DEADLOCK_RETRIES = 3;

function rowsFrom(result) {
  if (Array.isArray(result)) {
    // mysql2's raw connection returns [rows, fields], while the shared app pool
    // wrapper returns { rows, ... }.
    if (Array.isArray(result[0])) return result[0];
    return result;
  }
  return Array.isArray(result?.rows) ? result.rows : [];
}

function isDeadlock(error) {
  return error?.errno === 1213
    || error?.errno === 1205
    || error?.code === 'ER_LOCK_DEADLOCK'
    || error?.code === 'ER_LOCK_WAIT_TIMEOUT';
}

function jsonSafeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Financial command result must be a JSON object.');
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Financial command result must be JSON-safe.', { details: { cause: cause.message } });
  }
  if (encoded === undefined) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Financial command result must be JSON-safe.');
  }
  try {
    const parsed = JSON.parse(encoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Financial command result must be a JSON object.');
    }
    return { encoded, value: parsed };
  } catch (cause) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Financial command result must be JSON-safe.', { details: { cause: cause.message } });
  }
}

function validateFingerprint(value) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'requestFingerprint must be sha256 followed by 64 lowercase hexadecimal characters.');
  }
  return value;
}

function validateDependencies({ pool, operationStore, idSource, clock }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Billing MySQL UnitOfWork requires a pool with connect().');
  for (const method of ['findForUpdate', 'start', 'complete']) {
    if (typeof operationStore?.[method] !== 'function') throw new TypeError(`Billing operation store requires ${method}().`);
  }
  if (typeof idSource?.newId !== 'function') throw new TypeError('Billing MySQL UnitOfWork requires idSource.newId().');
  if (typeof clock?.now !== 'function') throw new TypeError('Billing MySQL UnitOfWork requires clock.now().');
}

function createMysqlUnitOfWork({ pool, operationStore, idSource, clock, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random }) {
  validateDependencies({ pool, operationStore, idSource, clock });

  async function runAttempt(args, fingerprint, callback) {
    const connection = await pool.connect();
    let transactionStarted = false;
    let committed = false;
    try {
      await connection.query('START TRANSACTION');
      transactionStarted = true;

      // This row is both the account state check and the per-organization
      // serialization lock. All financial commands lock it before any other
      // billing record, as specified by the billing lock order.
      const accountResult = await connection.query(
        `SELECT org_id, status, hold_reason, version
           FROM organization_billing_accounts
          WHERE org_id = ?
          FOR UPDATE`,
        [args.orgId],
      );
      const account = rowsFrom(accountResult)[0];
      if (!account) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Organization billing account does not exist.');
      }
      if (!args.allowInactiveAccount && (String(account.status).toLowerCase() !== 'active' || account.hold_reason)) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Organization billing account is held or inactive.', {
          details: { status: account.status, held: Boolean(account.hold_reason) },
        });
      }

      const metadata = {
        orgId: args.orgId,
        operationId: args.operationId,
        billingAccountVersion: account.version,
      };
      if (args.expectedVersions !== undefined) metadata.expectedVersions = args.expectedVersions;
      const tx = createTransactionContext(connection, metadata);
      const prior = await operationStore.findForUpdate(tx, { orgId: args.orgId, operationId: args.operationId });
      if (prior) {
        if (prior.requestFingerprint !== fingerprint) {
          throw new BillingDomainError(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Idempotency key was already used with a different request.');
        }
        if (String(prior.status).toLowerCase() === 'completed') {
          const result = typeof prior.result === 'string' ? JSON.parse(prior.result) : prior.result;
          if (result === null || typeof result !== 'object') {
            throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Stored financial operation result is invalid.');
          }
          await connection.query('COMMIT');
          committed = true;
          return result;
        }
        throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY, 'A prior financial operation with this key is incomplete.', { retryable: true });
      }

      const now = clock.now();
      await operationStore.start(tx, {
        id: idSource.newId('billing-operation'),
        orgId: args.orgId,
        operationId: args.operationId,
        requestFingerprint: fingerprint,
        now,
      });

      const rawResult = await callback(tx);
      const safe = jsonSafeResult(rawResult);
      await operationStore.complete(tx, {
        orgId: args.orgId,
        operationId: args.operationId,
        result: safe.value,
        now: clock.now(),
      });
      await connection.query('COMMIT');
      committed = true;
      return safe.value;
    } catch (error) {
      if (transactionStarted && !committed) {
        try { await connection.query('ROLLBACK'); } catch (_) { /* retain the original failure */ }
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  return Object.freeze({
    async runFinancial({ orgId, operationId, requestFingerprint, expectedVersions, callback } = {}) {
      return runSerialized({ orgId, operationId, requestFingerprint, expectedVersions, callback, allowInactiveAccount: false });
    },
    // Trusted lifecycle maintenance (expiry/reconciliation) must still run for
    // held accounts; all other idempotency, locking and transaction checks stay
    // identical to financial commands. This is an internal application port,
    // never expose it directly to HTTP callers.
    async runLifecycle({ orgId, operationId, requestFingerprint, expectedVersions, callback } = {}) {
      return runSerialized({ orgId, operationId, requestFingerprint, expectedVersions, callback, allowInactiveAccount: true });
    },
  });

  async function runSerialized({ orgId, operationId, requestFingerprint, expectedVersions, callback, allowInactiveAccount }) {
      validateId(orgId, 'orgId');
      validateId(operationId, 'operationId');
      const fingerprint = validateFingerprint(requestFingerprint);
      const validatedVersions = validateExpectedVersions(expectedVersions);
      if (typeof callback !== 'function') throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Financial command callback is required.');

      let retries = 0;
      while (true) {
        try {
          return await runAttempt({ orgId, operationId, expectedVersions: validatedVersions, allowInactiveAccount }, fingerprint, callback);
        } catch (error) {
          if (!isDeadlock(error) || retries >= MAX_DEADLOCK_RETRIES) throw error;
          retries += 1;
          // Short randomized backoff avoids synchronized retries while keeping
          // the total retry window bounded. The callback must contain DB work
          // only; transaction rollback makes retry safe.
          await sleep(Math.floor(5 + random() * 20) * retries);
        }
      }
  }
}

module.exports = {
  createMysqlUnitOfWork,
  isDeadlock,
  jsonSafeResult,
  FINGERPRINT_PATTERN,
  MAX_DEADLOCK_RETRIES,
};
