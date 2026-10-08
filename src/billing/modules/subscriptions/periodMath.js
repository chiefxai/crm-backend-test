'use strict';

// Billing periods are half-open UTC intervals [startsAt, endsAt). Calendar
// anchoring happens in the explicitly supplied IANA zone. Plan intervals are
// always arguments copied from purchased terms; this module has no defaults.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const VALID_UNITS = new Set(['day', 'week', 'month', 'year']);

function instant(value, path) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError(`${path} must be a valid timestamp.`);
  return result;
}

function interval(value) {
  if (!value || typeof value !== 'object' || !VALID_UNITS.has(value.unit)
    || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 1_000_000_000) {
    throw new TypeError('interval must contain a supported unit and a positive safe count.');
  }
  return { unit: value.unit, count: value.count };
}

function zoneFormatter(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) throw new TypeError('timeZone must be an IANA timezone.');
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch (error) {
    throw new TypeError(`timeZone is not supported: ${timeZone}`);
  }
}

function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(zoneFormatter(timeZone).formatToParts(date)
    .filter((part) => part.type !== 'literal').map(({ type, value }) => [type, Number(value)]));
  return {
    year: parts.year, month: parts.month, day: parts.day,
    hour: parts.hour, minute: parts.minute, second: parts.second,
    millisecond: date.getUTCMilliseconds(),
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function sameLocal(a, b) {
  return ['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond']
    .every((key) => a[key] === b[key]);
}

function compareLocal(a, b) {
  for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

function localToUtc(parts, timeZone) {
  const formatter = zoneFormatter(timeZone);
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  const offsets = new Set();
  // Sample either side of the target to capture DST transitions and historical
  // offset changes. Exact candidates make repeated-hour resolution deterministic.
  for (let delta = -36; delta <= 36; delta += 6) {
    const sample = new Date(naive + delta * 60 * 60 * 1000);
    const got = Object.fromEntries(formatter.formatToParts(sample)
      .filter((part) => part.type !== 'literal').map(({ type, value }) => [type, Number(value)]));
    const localAsUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second, sample.getUTCMilliseconds());
    offsets.add(localAsUtc - sample.getTime());
  }
  const candidates = [...offsets].map((offset) => new Date(naive - offset)).sort((a, b) => a - b);
  const exact = candidates.filter((candidate) => sameLocal(zonedParts(candidate, timeZone), parts));
  // During a repeated local hour, choose the earlier instant (compatible).
  if (exact.length) return exact[0];
  // A wall-clock time in a spring DST gap advances by the size of the gap.
  const after = candidates.map((candidate) => ({ candidate, parts: zonedParts(candidate, timeZone) }))
    .filter(({ parts: actual }) => compareLocal(actual, parts) > 0)
    .sort((a, b) => compareLocal(a.parts, b.parts) || a.candidate - b.candidate);
  if (after.length) return after[0].candidate;
  throw new RangeError('Could not resolve local billing boundary in timezone.');
}

function addCalendarInterval(anchor, intervalValue, { timeZone = 'UTC', anchorDay } = {}) {
  const base = instant(anchor, 'anchor');
  const step = interval(intervalValue);
  const local = zonedParts(base, timeZone);
  if (anchorDay !== undefined && (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31)) {
    throw new TypeError('anchorDay must be an integer from 1 to 31.');
  }
  let target = { ...local };
  if (step.unit === 'day' || step.unit === 'week') {
    const amount = step.count * (step.unit === 'week' ? 7 : 1);
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + amount));
    target.year = date.getUTCFullYear(); target.month = date.getUTCMonth() + 1; target.day = date.getUTCDate();
  } else {
    const months = step.count * (step.unit === 'year' ? 12 : 1);
    const totalMonths = local.year * 12 + (local.month - 1) + months;
    target.year = Math.floor(totalMonths / 12);
    target.month = (totalMonths % 12) + 1;
    target.day = Math.min(anchorDay ?? local.day, daysInMonth(target.year, target.month));
  }
  return localToUtc(target, timeZone).toISOString();
}

function boundaryAt(anchor, step, index, timeZone, anchorDay) {
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('period index must be a non-negative integer.');
  if (index === 0) return instant(anchor, 'anchor').toISOString();
  return addCalendarInterval(anchor, { unit: step.unit, count: step.count * index }, { timeZone, anchorDay });
}

function periodIndexAtOrBefore(anchor, step, at, timeZone, anchorDay) {
  const target = instant(at, 'at').getTime();
  let low = 0; let high = 1;
  while (Date.parse(boundaryAt(anchor, step, high, timeZone, anchorDay)) <= target) {
    low = high; high *= 2;
    if (high > 1_000_000) throw new RangeError('Could not find period index.');
  }
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (Date.parse(boundaryAt(anchor, step, mid, timeZone, anchorDay)) <= target) low = mid;
    else high = mid;
  }
  return low;
}

function makePeriod({ anchorAt, startsAt, interval: step, periodIndex, timeZone, anchorDay, lateRenewal = false }) {
  const endsAt = boundaryAt(anchorAt, step, periodIndex + 1, timeZone, anchorDay);
  return Object.freeze({
    startsAt: instant(startsAt, 'startsAt').toISOString(), endsAt,
    anchorAt: instant(anchorAt, 'anchorAt').toISOString(), periodIndex,
    lateRenewal: Boolean(lateRenewal),
  });
}

/** Preview a purchased subscription period using only its snapshotted interval. */
function previewSubscriptionPeriod({
  purchasedAt, intervalUnit, intervalCount, anchorDay, timeZone = 'UTC', now = purchasedAt, previousPeriod,
}) {
  const step = interval({ unit: intervalUnit, count: intervalCount });
  const paidAt = instant(purchasedAt, 'purchasedAt');
  const currentEnd = previousPeriod?.endsAt == null ? null : instant(previousPeriod.endsAt, 'previousPeriod.endsAt');
  const early = currentEnd && paidAt.getTime() < currentEnd.getTime();
  const late = currentEnd && paidAt.getTime() >= currentEnd.getTime();
  const startsAt = early ? currentEnd : paidAt;
  const anchorAt = early && previousPeriod.anchorAt ? instant(previousPeriod.anchorAt, 'previousPeriod.anchorAt') : startsAt;
  const day = anchorDay ?? (early ? zonedParts(anchorAt, timeZone).day : zonedParts(startsAt, timeZone).day);
  const periodIndex = early
    ? periodIndexAtOrBefore(anchorAt, step, startsAt, timeZone, day)
    : 0;
  const result = makePeriod({ anchorAt, startsAt, interval: step, periodIndex, timeZone, anchorDay: day, lateRenewal: Boolean(late) });
  const nowTime = instant(now, 'now').getTime();
  return Object.freeze({ ...result, previewedAt: new Date(nowTime).toISOString() });
}

/** Preview the current no-subscription postpaid cycle from its persisted anchor. */
function previewPostpaidPeriod({ anchorAt, intervalUnit, intervalCount, timeZone = 'UTC', now }) {
  const step = interval({ unit: intervalUnit, count: intervalCount });
  const anchor = instant(anchorAt, 'anchorAt');
  const index = periodIndexAtOrBefore(anchor, step, now, timeZone, zonedParts(anchor, timeZone).day);
  return makePeriod({ anchorAt: anchor, startsAt: boundaryAt(anchor, step, index, timeZone), interval: step, periodIndex: index, timeZone, anchorDay: zonedParts(anchor, timeZone).day });
}

/** A paid renewal before expiry is scheduled at the existing end; it does not reset this cycle. */
function previewEarlyRenewal({ currentPeriod, purchasedAt, intervalUnit, intervalCount, anchorDay, timeZone = 'UTC', now = purchasedAt }) {
  if (!currentPeriod || !currentPeriod.endsAt) throw new TypeError('currentPeriod.endsAt is required.');
  const result = previewSubscriptionPeriod({
    purchasedAt, intervalUnit, intervalCount, anchorDay, timeZone, now, previousPeriod: currentPeriod,
  });
  if (result.lateRenewal) throw new RangeError('Early renewal must be paid before the current period ends.');
  return result;
}

/** Require funding, due time, a schedulable status, and non-overlap before activation. */
function evaluatePeriodActivation({ period, now, existingPeriods = [], funded = false }) {
  if (!period || !period.startsAt || !period.endsAt) throw new TypeError('period startsAt and endsAt are required.');
  const start = instant(period.startsAt, 'period.startsAt').getTime();
  const end = instant(period.endsAt, 'period.endsAt').getTime();
  if (end <= start) throw new RangeError('period endsAt must be after startsAt.');
  const at = instant(now, 'now').getTime();
  if (period.status !== 'scheduled') return Object.freeze({ eligible: false, reason: 'not_scheduled' });
  if (!funded) return Object.freeze({ eligible: false, reason: 'not_funded' });
  if (start > at) return Object.freeze({ eligible: false, reason: 'not_due' });
  for (const existing of existingPeriods) {
    // Ended records are historical and still participate in interval
    // integrity; only a cancelled (never-effective) period is ignored.
    if (!existing || existing.id === period.id || existing.status === 'cancelled') continue;
    const otherStart = instant(existing.startsAt, 'existingPeriod.startsAt').getTime();
    const otherEnd = instant(existing.endsAt, 'existingPeriod.endsAt').getTime();
    if (start < otherEnd && otherStart < end) return Object.freeze({ eligible: false, reason: 'overlap', conflictingPeriodId: existing.id ?? null });
  }
  return Object.freeze({ eligible: true, reason: null });
}

module.exports = {
  addCalendarInterval,
  previewSubscriptionPeriod,
  previewEarlyRenewal,
  previewPostpaidPeriod,
  evaluatePeriodActivation,
};
