'use strict';

// A transaction context exposes only the query capability repositories need.
// The underlying connection and transaction lifecycle remain private to UoW.
const transactionContexts = new WeakSet();

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function copyMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(metadata))) {
    throw new TypeError('Transaction metadata must be a plain object.');
  }
  let encoded;
  try {
    encoded = JSON.stringify(metadata);
  } catch (error) {
    throw new TypeError(`Transaction metadata must be JSON-safe: ${error.message}`);
  }
  if (encoded === undefined) throw new TypeError('Transaction metadata must be JSON-safe.');
  let copied;
  try {
    copied = JSON.parse(encoded);
  } catch (error) {
    throw new TypeError(`Transaction metadata must be JSON-safe: ${error.message}`);
  }
  if (!copied || typeof copied !== 'object' || Array.isArray(copied)) {
    throw new TypeError('Transaction metadata must serialize to a plain object.');
  }
  return freezeDeep(copied);
}

function createTransactionContext(client, metadata = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A transaction client with query(sql, params) is required.');
  }
  const safeMetadata = copyMetadata(metadata);
  const context = Object.freeze({
    metadata: safeMetadata,
    query(sql, params = []) {
      return client.query(sql, params);
    },
  });
  transactionContexts.add(context);
  return context;
}

function assertTransactionContext(tx) {
  if (!tx || typeof tx !== 'object' || !transactionContexts.has(tx)) {
    throw new TypeError('A transaction context created by UnitOfWork or another transaction runner is required.');
  }
  return tx;
}

module.exports = { createTransactionContext, assertTransactionContext };
