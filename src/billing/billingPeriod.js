// Calendar-month billing period in an organization's timezone (defaults to Asia/Kolkata).
function getTimezone(org) {
  const tz = org?.settings?.billing?.timezone || org?.settings?.timezone || "Asia/Kolkata";
  return tz;
}

function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function getCurrentBillingPeriod(org, now = new Date()) {
  const timeZone = getTimezone(org);
  const { year, month } = getZonedParts(now, timeZone);
  const label = new Intl.DateTimeFormat("en-US", { timeZone, month: "long", year: "numeric" }).format(now);
  const startLocal = `${year}-${String(month).padStart(2, "0")}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endLocal = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;
  return {
    timeZone,
    label,
    startIso: startLocal,
    endIso: endLocal,
    startLocal,
    endLocal: `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`,
  };
}

module.exports = {
  getTimezone,
  getCurrentBillingPeriod,
};
