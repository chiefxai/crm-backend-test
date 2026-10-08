'use strict';

const { createAmount, validateAmount } = require('../../kernel/amount');
const { normalizeUsageEvent } = require('../../modules/funding/usageEvents');

function positiveInteger(value, field) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new TypeError(`${field} must be a positive integer string.`);
  return BigInt(value);
}

function pow10(scale) { return 10n ** BigInt(scale); }

function rateQuantity({ quantity, unitQuantity, unitRate, rounding = 'half_up' }) {
  if (!quantity || !Number.isInteger(quantity.scale) || quantity.scale < 0 || quantity.scale > 18
    || typeof quantity.units !== 'string' || !/^(0|[1-9]\d*)$/.test(quantity.units)) {
    throw new TypeError('quantity must contain canonical non-negative units and scale.');
  }
  if (!unitQuantity || !Number.isInteger(unitQuantity.scale) || unitQuantity.scale < 0 || unitQuantity.scale > 18) {
    throw new TypeError('unitQuantity must contain positive units and scale.');
  }
  if (rounding !== 'half_up' && rounding !== 'down') throw new TypeError('rounding must be half_up or down.');
  const basisUnits = positiveInteger(unitQuantity.units, 'unitQuantity.units');
  const rate = validateAmount(unitRate);
  if (BigInt(rate.units) < 0n) throw new TypeError('unitRate must not be negative.');
  const numerator = BigInt(quantity.units) * pow10(unitQuantity.scale) * BigInt(rate.units);
  const denominator = pow10(quantity.scale) * basisUnits;
  let units = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder !== 0n) {
    if (rounding === 'half_up' && remainder * 2n >= denominator) units += 1n;
  }
  return createAmount(rate.asset, units, rate.scale);
}

function createPayableUsageEvent({ event, quantity, unitQuantity, unitRate, rateVersion, rateSnapshot, rounding = 'half_up' }) {
  if (!event || typeof event !== 'object') throw new TypeError('event context is required.');
  if (typeof rateVersion !== 'string' || !rateVersion.trim()) throw new TypeError('rateVersion is required for payable usage.');
  if (!rateSnapshot || typeof rateSnapshot !== 'object' || Array.isArray(rateSnapshot)) throw new TypeError('rateSnapshot is required.');
  const amount = rateQuantity({ quantity, unitQuantity, unitRate, rounding });
  return normalizeUsageEvent({
    ...event,
    status: 'payable',
    quantity,
    amount,
    pricingSnapshot: {
      schemaVersion: 1,
      operationId: event.operationId,
      kind: 'credit_rate',
      estimated: false,
      rateVersion,
      ratedAmount: amount,
      rateSnapshot: { ...rateSnapshot, unitQuantity, unitRate, rounding },
    },
  });
}

function createEstimatedUsageEvent({ event, quantity, creditAsset, creditScale = 0, estimateSnapshot, status = 'estimated' }) {
  if (!event || typeof event !== 'object') throw new TypeError('event context is required.');
  if (!['estimated', 'excluded'].includes(status)) throw new TypeError('estimated adapter status must be estimated or excluded.');
  if (!estimateSnapshot || typeof estimateSnapshot !== 'object' || Array.isArray(estimateSnapshot)) throw new TypeError('estimateSnapshot is required.');
  return normalizeUsageEvent({
    ...event,
    status,
    quantity,
    amount: createAmount(creditAsset, '0', creditScale),
    pricingSnapshot: {
      schemaVersion: 1,
      operationId: event.operationId,
      kind: 'legacy_estimate',
      estimated: true,
      estimate: estimateSnapshot,
    },
  });
}

module.exports = { rateQuantity, createPayableUsageEvent, createEstimatedUsageEvent };
