'use strict';

const amount = require('../../../src/billing/kernel/amount');

describe('billing amount kernel', () => {
  test('keeps fractional values exact and serializes decimal strings', () => {
    const value = amount.fromDecimal('INR', '123.456789', 6);
    expect(value).toEqual({ asset: 'INR', units: '123456789', scale: 6 });
    expect(amount.toDecimal(value)).toBe('123.456789');
    expect(amount.toDecimal(amount.fromDecimal('CREDIT.INR', '-0.5', 6), { trimTrailingZeros: true })).toBe('-0.5');
  });

  test('requires explicit precision policy and rounds negative values correctly', () => {
    expect(() => amount.fromDecimal('INR', '1.239', 2)).toThrow(expect.objectContaining({ code: 'AMOUNT_PRECISION_LOSS' }));
    expect(amount.fromDecimal('INR', '1.239', 2, 'half_up').units).toBe('124');
    expect(amount.fromDecimal('INR', '-1.231', 2, 'floor').units).toBe('-124');
    expect(amount.fromDecimal('INR', '-1.239', 2, 'ceil').units).toBe('-123');
    expect(amount.fromDecimal('INR', '2.5', 0, 'half_even').units).toBe('2');
    expect(amount.fromDecimal('INR', '3.5', 0, 'half_even').units).toBe('4');
  });

  test('requires matching asset and scale for arithmetic', () => {
    const rupees = amount.fromDecimal('INR', '2.50', 2);
    expect(amount.add(rupees, amount.fromDecimal('INR', '1.25', 2)).units).toBe('375');
    expect(amount.compare(rupees, amount.fromDecimal('INR', '2.49', 2))).toBe(1);
    expect(() => amount.add(rupees, amount.fromDecimal('USD', '1.00', 2))).toThrow(expect.objectContaining({ code: 'MIXED_ASSET' }));
    expect(() => amount.subtract(rupees, amount.fromDecimal('INR', '1', 0))).toThrow(expect.objectContaining({ code: 'MIXED_SCALE' }));
  });

  test('rescaling requires explicit rounding and guards signed BIGINT range', () => {
    expect(amount.rescale(amount.fromDecimal('INR', '1.25', 2), 1, 'half_up').units).toBe('13');
    expect(amount.rescale(amount.fromDecimal('INR', '1.20', 2), 1).units).toBe('12');
    expect(() => amount.createAmount('INR', '9223372036854775808', 0)).toThrow(expect.objectContaining({ code: 'AMOUNT_OVERFLOW' }));
    expect(() => amount.add(amount.createAmount('INR', amount.MAX_UNITS, 0), amount.createAmount('INR', '1', 0))).toThrow(expect.objectContaining({ code: 'AMOUNT_OVERFLOW' }));
  });

  test('rejects non-canonical or malformed amounts', () => {
    expect(() => amount.createAmount('inr', '1', 0)).toThrow();
    expect(() => amount.createAmount('INR', '01', 0)).toThrow();
    expect(() => amount.createAmount('INR', '1.0', 0)).toThrow();
    expect(() => amount.validateAmount({ asset: 'INR', units: '1', scale: 0, balance: '1' })).toThrow();
  });
});
