// src/lib/timezoneConvert.js
// ============================================================
// Minimal IANA-timezone-aware date conversion using only the built-in
// Intl API — no date library needed for what the callback-scheduling
// agent requires: "what is 'now' in this caller's zone" and "what UTC
// instant does this wall-clock time in their zone correspond to".
// ============================================================

// The caller's current wall-clock date/time, formatted as
// "YYYY-MM-DDTHH:mm:ss" — what a clock on their wall would show right
// now, given their timezone. Used to give the follow-up agent an accurate
// frame of reference instead of the server's own (UTC) "today".
function nowInTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

// Converts a wall-clock date/time string (no timezone designator, e.g.
// "2026-09-17T17:00:00" — 5pm as read on the caller's own clock) into the
// real UTC instant that represents, given their IANA timezone. DST-aware:
// resolves the offset actually in effect on that specific date, not a
// fixed offset. Returns null if the input can't be parsed at all.
//
// How it works: interpret the string as if it were already UTC to get a
// baseline instant, then ask what that same instant reads as when
// formatted in the target timezone — the gap between the two is exactly
// the zone's offset at that moment, which corrects the baseline into the
// real UTC instant for the original wall-clock time.
//
// Deliberately reconstructs the "zoned reading" with Date.UTC(...) from
// formatToParts' numeric fields rather than re-parsing a locale string
// with `new Date(string)` — that re-parse is itself interpreted in the
// RUNNING PROCESS's own local timezone for a string with no zone
// designator, silently corrupting the result on any machine whose TZ
// isn't UTC (confirmed live: correct by sheer coincidence on a sandbox
// already set to Asia/Kolkata, wrong everywhere else). Date.UTC is
// unambiguous regardless of the server's own timezone.
function zonedTimeToUtc(localDateTimeStr, timeZone) {
  const cleaned = String(localDateTimeStr || "").trim();
  if (!cleaned) return null;
  const asIfUtc = new Date(cleaned.endsWith("Z") ? cleaned : `${cleaned}Z`);
  if (Number.isNaN(asIfUtc.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(asIfUtc);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  // Intl's hour12:false can format midnight as "24" in some environments —
  // normalize before feeding Date.UTC.
  const zonedAsUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));

  const offsetMs = asIfUtc.getTime() - zonedAsUtcMs;
  return new Date(asIfUtc.getTime() + offsetMs);
}

function formatInstantInTimezone(iso, timeZone) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch (_) {
    return date.toISOString();
  }
}

module.exports = { nowInTimezone, zonedTimeToUtc, formatInstantInTimezone };
