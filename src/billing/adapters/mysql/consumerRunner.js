'use strict';

const { validateId } = require('../../kernel/scope');
const { createTransactionContext } = require('../../kernel/transactionContext');

const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_DEADLOCK_RETRIES = 3;

function isDeadlock(error) {
  return error?.errno === 1213
    || error?.errno === 1205
    || error?.code === 'ER_LOCK_DEADLOCK'
    || error?.code === 'ER_LOCK_WAIT_TIMEOUT';
}

function validateDependencies({ pool }) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('Billing MySQL consumer runner requires a pool with connect().');
  }
}

/**
 * Run a consumer callback in a branded MySQL transaction without applying
 * financial-account state gates or command-operation persistence. The inbox
 * adapter must be called inside this callback so its marker and consumer DB
 * effects commit or roll back together.
 */
function createMysqlConsumerRunner({
  pool,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  validateDependencies({ pool });

  async function attempt({ orgId, operationId, requestFingerprint, callback }) {
    const connection = await pool.connect();
    let started = false;
    let committed = false;
    try {
      await connection.query('START TRANSACTION');
      started = true;
      const tx = createTransactionContext(connection, { orgId, operationId, requestFingerprint });
      const result = await callback(tx);
      await connection.query('COMMIT');
      committed = true;
      return result;
    } catch (error) {
      if (started && !committed) {
        try { await connection.query('ROLLBACK'); } catch (_) { /* retain the original error */ }
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  return Object.freeze({
    async runConsumer({ orgId, operationId, requestFingerprint, callback } = {}) {
      validateId(orgId, 'orgId');
      validateId(operationId, 'operationId');
      if (typeof requestFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(requestFingerprint)) {
        throw new TypeError('requestFingerprint must be sha256 followed by 64 lowercase hexadecimal characters.');
      }
      if (typeof callback !== 'function') throw new TypeError('Consumer transaction callback is required.');

      let retries = 0;
      while (true) {
        try {
          return await attempt({ orgId, operationId, requestFingerprint, callback });
        } catch (error) {
          if (!isDeadlock(error) || retries >= MAX_DEADLOCK_RETRIES) throw error;
          retries += 1;
          await sleep(Math.floor(5 + random() * 20) * retries);
        }
      }
    },
  });
}

module.exports = { createMysqlConsumerRunner, isDeadlock, MAX_DEADLOCK_RETRIES, FINGERPRINT_PATTERN };
