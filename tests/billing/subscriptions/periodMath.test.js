'use strict';

const {
  addCalendarInterval,
  previewSubscriptionPeriod,
  previewEarlyRenewal,
  previewPostpaidPeriod,
  evaluatePeriodActivation,
} = require('../../../src/billing/modules/subscriptions/periodMath');

describe('subscription period math', () => {
  test('preserves a monthly anchor through short months', () => {
    expect(addCalendarInterval('2025-01-31T15:45:00.000Z', { unit: 'month', count: 1 }))
      .toBe('2025-02-28T15:45:00.000Z');
    expect(addCalendarInterval('2025-01-31T15:45:00.000Z', { unit: 'month', count: 2 }))
      .toBe('2025-03-31T15:45:00.000Z');
    expect(addCalendarInterval('2024-01-31T15:45:00.000Z', { unit: 'month', count: 1 }))
      .toBe('2024-02-29T15:45:00.000Z');
  });

  test('keeps leap-day annual anchors for later leap years', () => {
    const anchor = '2024-02-29T10:20:00.000Z';
    expect(addCalendarInterval(anchor, { unit: 'year', count: 1 })).toBe('2025-02-28T10:20:00.000Z');
    expect(addCalendarInterval(anchor, { unit: 'year', count: 4 })).toBe('2028-02-29T10:20:00.000Z');
  });

  test('anchors calendar boundaries in the explicit timezone and returns UTC instants', () => {
    expect(addCalendarInterval('2025-01-31T18:30:00.000Z', { unit: 'month', count: 1 }, { timeZone: 'Asia/Kolkata' }))
      .toBe('2025-02-28T18:30:00.000Z');
    // New York 09:00 crosses spring DST; the wall time stays at 09:00.
    expect(addCalendarInterval('2025-02-10T14:00:00.000Z', { unit: 'month', count: 1 }, { timeZone: 'America/New_York' }))
      .toBe('2025-03-10T13:00:00.000Z');
  });

  test('resolves a nonexistent DST wall time compatibly by advancing through the gap', () => {
    expect(addCalendarInterval('2025-02-09T07:30:00.000Z', { unit: 'month', count: 1 }, { timeZone: 'America/New_York' }))
      .toBe('2025-03-09T07:30:00.000Z'); // 03:30 local after the 02:30 gap
  });

  test('starts early renewal at the current end and keeps the original anchor', () => {
    const currentPeriod = {
      id: 'p1', status: 'active', anchorAt: '2025-01-31T00:00:00.000Z',
      startsAt: '2025-01-31T00:00:00.000Z', endsAt: '2025-02-28T00:00:00.000Z',
    };
    expect(previewEarlyRenewal({
      currentPeriod, purchasedAt: '2025-02-10T00:00:00.000Z', intervalUnit: 'month', intervalCount: 1,
    })).toMatchObject({
      startsAt: '2025-02-28T00:00:00.000Z', endsAt: '2025-03-31T00:00:00.000Z',
      anchorAt: '2025-01-31T00:00:00.000Z', periodIndex: 1, lateRenewal: false,
    });
    expect(currentPeriod.endsAt).toBe('2025-02-28T00:00:00.000Z');
  });

  test('late renewal starts at approval time instead of backdating into the expired cycle', () => {
    const result = previewSubscriptionPeriod({
      previousPeriod: { endsAt: '2025-02-28T00:00:00.000Z', anchorAt: '2025-01-31T00:00:00.000Z' },
      purchasedAt: '2025-03-03T12:00:00.000Z', now: '2025-03-03T12:00:00.000Z',
      intervalUnit: 'month', intervalCount: 1,
    });
    expect(result).toMatchObject({
      startsAt: '2025-03-03T12:00:00.000Z', endsAt: '2025-04-03T12:00:00.000Z',
      anchorAt: '2025-03-03T12:00:00.000Z', periodIndex: 0, lateRenewal: true,
    });
  });

  test('uses the persisted postpaid anchor to find the current cycle, without calendar-month globals', () => {
    expect(previewPostpaidPeriod({
      anchorAt: '2025-01-31T10:00:00.000Z', intervalUnit: 'month', intervalCount: 1,
      now: '2025-03-15T00:00:00.000Z',
    })).toMatchObject({
      startsAt: '2025-02-28T10:00:00.000Z', endsAt: '2025-03-31T10:00:00.000Z',
      anchorAt: '2025-01-31T10:00:00.000Z', periodIndex: 1,
    });
  });

  test('requires scheduled, funded, due periods and rejects overlapping windows', () => {
    const period = { id: 'candidate', status: 'scheduled', startsAt: '2025-02-01T00:00:00Z', endsAt: '2025-03-01T00:00:00Z' };
    const now = '2025-02-01T00:00:00Z';
    expect(evaluatePeriodActivation({ period, now }).reason).toBe('not_funded');
    expect(evaluatePeriodActivation({ period, now, funded: true }).eligible).toBe(true);
    expect(evaluatePeriodActivation({ period, now: '2025-01-31T23:59:59Z', funded: true }).reason).toBe('not_due');
    expect(evaluatePeriodActivation({ period: { ...period, status: 'active' }, now, funded: true }).reason).toBe('not_scheduled');
    expect(evaluatePeriodActivation({
      period, now, funded: true,
      existingPeriods: [{ id: 'other', status: 'active', startsAt: '2025-02-15T00:00:00Z', endsAt: '2025-03-15T00:00:00Z' }],
    })).toMatchObject({ eligible: false, reason: 'overlap', conflictingPeriodId: 'other' });
    expect(evaluatePeriodActivation({
      period, now, funded: true,
      existingPeriods: [{ id: 'adjacent', status: 'active', startsAt: '2025-03-01T00:00:00Z', endsAt: '2025-04-01T00:00:00Z' }],
    }).eligible).toBe(true);
    expect(evaluatePeriodActivation({
      period, now, funded: true,
      existingPeriods: [{ id: 'cancelled', status: 'cancelled', startsAt: '2025-02-15T00:00:00Z', endsAt: '2025-03-15T00:00:00Z' }],
    }).eligible).toBe(true);
    expect(evaluatePeriodActivation({
      period, now, funded: true,
      existingPeriods: [{ id: 'ended', status: 'ended', startsAt: '2025-02-15T00:00:00Z', endsAt: '2025-03-15T00:00:00Z' }],
    })).toMatchObject({ eligible: false, reason: 'overlap', conflictingPeriodId: 'ended' });
  });

  test('rejects missing purchased interval and invalid timezone rather than silently substituting defaults', () => {
    expect(() => previewSubscriptionPeriod({ purchasedAt: '2025-01-01T00:00:00Z' })).toThrow(/interval/);
    expect(() => addCalendarInterval('2025-01-01T00:00:00Z', { unit: 'month', count: 1 }, { timeZone: 'Mars/Phobos' })).toThrow(/timeZone/);
  });
});
