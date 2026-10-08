'use strict';

// Amounts cross API and persistence boundaries as decimal strings. Keep all
// arithmetic in BigInt so values are never rounded by JavaScript Number.
const MAX_SCALE = 18;
const MAX_UNITS = 9223372036854775807n;
const MIN_UNITS = -9223372036854775808n;
const ASSET_PATTERN = /^[A-Z][A-Z0-9._:-]{0,31}$/;
const ROUNDING_MODES = new Set(['reject', 'down', 'floor', 'ceil', 'half_up', 'half_even']);

class AmountValidationError extends TypeError {
  constructor(message, code = 'INVALID_AMOUNT') {
    super(message);
    this.name = 'AmountValidationError';
    this.code = code;
  }
}

function invalid(message, code) {
  throw new AmountValidationError(message, code);
}

function validateAsset(asset) {
  if (typeof asset !== 'string' || !ASSET_PATTERN.test(asset)) {
    invalid('asset must be a supported uppercase asset identifier.');
  }
  return asset;
}

function validateScale(scale) {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    invalid(`scale must be an integer from 0 to ${MAX_SCALE}.`);
  }
  return scale;
}

function parseUnits(units) {
  if (typeof units !== 'string' || !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(units)) {
    invalid('units must be a canonical decimal integer string.');
  }
  let value;
  try {
    value = BigInt(units);
  } catch (_) {
    invalid('units is outside the supported integer range.', 'AMOUNT_OVERFLOW');
  }
  if (value < MIN_UNITS || value > MAX_UNITS) {
    invalid('units is outside the signed 64-bit range.', 'AMOUNT_OVERFLOW');
  }
  return value;
}

function validateAmount(amount) {
  if (!amount || typeof amount !== 'object' || Array.isArray(amount)) {
    invalid('amount must be an object.');
  }
  const keys = Object.keys(amount).sort();
  if (keys.length !== 3 || keys[0] !== 'asset' || keys[1] !== 'scale' || keys[2] !== 'units') {
    invalid('amount must contain exactly asset, units, and scale.');
  }
  validateAsset(amount.asset);
  parseUnits(amount.units);
  validateScale(amount.scale);
  return Object.freeze({ asset: amount.asset, units: amount.units, scale: amount.scale });
}

function createAmount(asset, units, scale) {
  return validateAmount({ asset, units: typeof units === 'bigint' ? units.toString() : units, scale });
}

function pow10(power) {
  return 10n ** BigInt(power);
}

function roundingMode(value) {
  if (!ROUNDING_MODES.has(value)) {
    invalid(`rounding must be one of: ${Array.from(ROUNDING_MODES).join(', ')}.`);
  }
  return value;
}

function divideRounded(numerator, denominator, mode) {
  if (denominator <= 0n) invalid('denominator must be positive.');
  const quotient = numerator / denominator; // BigInt division truncates toward zero.
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  if (mode === 'reject') invalid('conversion would lose precision; provide an explicit rounding mode.', 'AMOUNT_PRECISION_LOSS');
  if (mode === 'down') return quotient;
  if (mode === 'floor') return numerator < 0n ? quotient - 1n : quotient;
  if (mode === 'ceil') return numerator > 0n ? quotient + 1n : quotient;

  const absRemainder = remainder < 0n ? -remainder : remainder;
  const twiceRemainder = absRemainder * 2n;
  if (twiceRemainder < denominator) return quotient;
  const sign = numerator < 0n ? -1n : 1n;
  if (twiceRemainder > denominator || mode === 'half_up') return quotient + sign;
  // Exact ties in half_even round to the nearest even integer.
  return quotient % 2n === 0n ? quotient : quotient + sign;
}

function fromDecimal(asset, decimal, scale, rounding = 'reject') {
  validateAsset(asset);
  validateScale(scale);
  roundingMode(rounding);
  if (typeof decimal !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimal)) {
    invalid('decimal must be a non-exponent decimal string.');
  }
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = `${whole}${fraction}`;
  let units = BigInt(digits || '0');
  if (negative) units = -units;
  const excess = fraction.length - scale;
  if (excess > 0) units = divideRounded(units, pow10(excess), rounding);
  else if (excess < 0) units *= pow10(-excess);
  return createAmount(asset, units, scale);
}

function toDecimal(amount, { trimTrailingZeros = false } = {}) {
  const valid = validateAmount(amount);
  const units = BigInt(valid.units);
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(valid.scale + 1, '0');
  if (valid.scale === 0) return `${negative ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -valid.scale);
  let fraction = digits.slice(-valid.scale);
  if (trimTrailingZeros) fraction = fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function rescale(amount, targetScale, rounding = 'reject') {
  const valid = validateAmount(amount);
  validateScale(targetScale);
  roundingMode(rounding);
  let units = BigInt(valid.units);
  if (targetScale > valid.scale) units *= pow10(targetScale - valid.scale);
  else if (targetScale < valid.scale) units = divideRounded(units, pow10(valid.scale - targetScale), rounding);
  return createAmount(valid.asset, units, targetScale);
}

function assertCompatible(left, right) {
  const a = validateAmount(left);
  const b = validateAmount(right);
  if (a.asset !== b.asset) invalid('amount assets must match.', 'MIXED_ASSET');
  if (a.scale !== b.scale) invalid('amount scales must match; rescale explicitly first.', 'MIXED_SCALE');
  return [a, b];
}

function add(left, right) {
  const [a, b] = assertCompatible(left, right);
  return createAmount(a.asset, BigInt(a.units) + BigInt(b.units), a.scale);
}

function subtract(left, right) {
  const [a, b] = assertCompatible(left, right);
  return createAmount(a.asset, BigInt(a.units) - BigInt(b.units), a.scale);
}

function compare(left, right) {
  const [a, b] = assertCompatible(left, right);
  const x = BigInt(a.units);
  const y = BigInt(b.units);
  return x < y ? -1 : x > y ? 1 : 0;
}

module.exports = {
  AmountValidationError,
  MAX_SCALE,
  MAX_UNITS: MAX_UNITS.toString(),
  MIN_UNITS: MIN_UNITS.toString(),
  ROUNDING_MODES: Object.freeze(Array.from(ROUNDING_MODES)),
  createAmount,
  validateAmount,
  fromDecimal,
  toDecimal,
  rescale,
  add,
  subtract,
  compare
};
