// ============================================================
// services/billingEngine.js
//
// Billing-period usage tracking only — there are no per-plan minute
// caps or call-blocking here. Does NOT collect real payments (that
// needs a live Stripe/Razorpay account this environment doesn't
// have) — this just resets aiMinutesUsed on a rolling 30-day period
// so the usage dashboard shows "minutes used this period."
// ============================================================

const db = require("../db/repository");
const { getCostPerMinuteInr, costForMinutes, getPhoneCostPerMinute } = require("../platform/pricing");
const costProviders = require("../platform/costProviders");
const channelsEngine = require("../channels/engine");

const BILLING_PERIOD_DAYS = 30;

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Only "vobiz" is self-manageable today (Settings > Numbers lets an org
// connect its own Vobiz.ai account instead of using the shared server
// account — see routes/channels.js POST /vobiz and vobizProxy.js/vobiz.js
// preferring that channel's credentials when present). Extend this map
// when a future call provider supports the same "bring your own account"
// connection.
const SELF_MANAGED_CALL_PROVIDER_CHANNEL_TYPE = { vobiz: "vobiz" };

// True when this org placed its calls through ITS OWN connected account
// for this provider rather than the platform's shared one — in that case
// the platform never actually paid the provider for those calls, so
// they must not be counted as something the org owes the platform, even
// though we still compute and show an estimate using the admin's rate
// (useful for the org to sanity-check their own provider bill).
async function isCallProviderSelfManaged(orgId, providerKey) {
  const channelType = SELF_MANAGED_CALL_PROVIDER_CHANNEL_TYPE[providerKey];
  if (!channelType || !orgId) return false;
  try {
    const channel = await channelsEngine.getChannel(orgId, channelType);
    return !!channel && channel.status === "connected";
  } catch {
    return false; // fail safe: treat as platform-managed (billable) if the check itself fails
  }
}

// Builds the billed AI-token-cost figure from the SUM of each session's
// cost as locked in at its own finalize time (ai_session_usage's
// platform_* columns — see geminiUsageTracker.js), never by recomputing
// raw tokens against today's rate. This is what makes a rate change on
// the Cost page apply only prospectively: a session already finalized
// keeps whatever cost it was actually charged, no matter how many times
// the admin changes the rate afterward. Returns null when nothing in
// range has been priced yet (rather than 0), so the frontend can tell
// "not priced yet" apart from "genuinely free."
function billedAiTokenCost(aiUsageSummary) {
  if (!aiUsageSummary || !aiUsageSummary.platformPricedCount) return null;
  return {
    baseCost: aiUsageSummary.platformBaseCostInr,
    taxAmount: aiUsageSummary.platformTaxAmountInr,
    totalCost: aiUsageSummary.platformTotalCostInr,
    pricedSessionCount: aiUsageSummary.platformPricedCount,
    sessionCount: aiUsageSummary.sessionCount,
  };
}

function callRecordOwner(record) {
  let snapshot = record?.snapshot || {};
  if (typeof snapshot === "string") { try { snapshot = JSON.parse(snapshot); } catch (_) { snapshot = {}; } }
  return record?.telephonyOwnerType || record?.telephony_owner_type || snapshot?.telephonyOwnerType || null;
}

function isCallProviderChargeBillable(record, legacySelfManaged = false) {
  const ownerType = callRecordOwner(record);
  if (ownerType === "organization") return false;
  if (ownerType === "platform") return true;
  return !legacySelfManaged;
}

async function phoneChargesAreBillable(org, legacySelfManaged, { allTime = false } = {}) {
  let records = [];
  try { records = await db.list("callbillingrecords", org.id); } catch (_) { /* retain legacy classification on read failures */ }
  const end = org.billingPeriodEnd ? new Date(org.billingPeriodEnd).getTime() : Infinity;
  const start = Number.isFinite(end) ? addDays(end, -BILLING_PERIOD_DAYS).getTime() : 0;
  const relevant = allTime ? records : records.filter(record => {
    const createdAt = new Date(record.createdAt || record.created_at || 0).getTime();
    return createdAt >= start && createdAt < end;
  });
  if (!relevant.length) return !legacySelfManaged;
  return relevant.some(record => isCallProviderChargeBillable(record, legacySelfManaged));
}

// Resets usage + rolls the billing period forward if the current period
// has ended (or was never set). Idempotent — calling this repeatedly
// within an active period is a no-op.
async function ensureCurrentPeriod(orgId) {
  const org = await db.getOrg(orgId);
  if (!org) return null;

  const now = new Date();
  const periodEnd = org.billingPeriodEnd ? new Date(org.billingPeriodEnd) : null;
  if (periodEnd && periodEnd > now) return org;

  const newPeriodEnd = addDays(now, BILLING_PERIOD_DAYS);
  return db.updateOrg(orgId, {
    aiMinutesUsed: 0,
    phoneCharges: 0,
    billingPeriodEnd: newPeriodEnd.toISOString().slice(0, 10)
  });
}

async function getBillingInfo(orgId) {
  const org = await ensureCurrentPeriod(orgId);
  if (!org) return null;
  const aiMinutesUsed = org.aiMinutesUsed || 0;
  const periodStart = org.billingPeriodEnd ? addDays(org.billingPeriodEnd, -BILLING_PERIOD_DAYS) : null;

  const [costPerMinuteInr, totalCostInr, phoneCostPerMinute, aiUsageSummary, callProvider, aiProviderNow, phoneChargesSelfManaged] = await Promise.all([
    getCostPerMinuteInr(),
    costForMinutes(aiMinutesUsed),
    getPhoneCostPerMinute(),
    db.getAiUsageSummary(orgId, { fromIso: periodStart ? periodStart.toISOString() : null }).catch(() => null),
    costProviders.getProviderByKey("vobiz", "call").catch(() => null),
    costProviders.getProviderByKey("gemini", "ai").catch(() => null),
    isCallProviderSelfManaged(orgId, "vobiz"),
  ]);
  const phoneChargesBillable = await phoneChargesAreBillable(org, phoneChargesSelfManaged);

  return {
    aiMinutesUsed,
    billingPeriodEnd: org.billingPeriodEnd,
    costPerMinuteInr,
    totalCostInr,
    // Always computed/shown using the admin's rate, regardless of who's
    // actually paying the provider — see phoneChargesBillable below.
    phoneCharges: org.phoneCharges || 0,
    phoneCostPerMinute,
    // False when this org connected its own Vobiz account (Settings >
    // Numbers): the platform never paid for those calls, so phoneCharges
    // above is an ESTIMATE for the org's own reference only, not
    // something owed to the platform. The frontend must not present it
    // as a bill/payment when this is false.
    phoneChargesBillable,
    callProvider: callProvider ? {
      key: callProvider.key, label: callProvider.label,
      rateUnit: callProvider.rateUnit, rateAmount: callProvider.rateAmount, taxPercent: callProvider.taxPercent || 0,
    } : null,
    aiTokenUsage: aiUsageSummary ? {
      totalTokens: aiUsageSummary.totalTokens,
      totalInputTokens: aiUsageSummary.totalInputTokens,
      totalOutputTokens: aiUsageSummary.totalOutputTokens,
      callCount: aiUsageSummary.callCount,
    } : null,
    // What was actually billed — the sum of each session's cost as it was
    // locked in at ITS OWN finalize time, not tokens x today's rate. See
    // billedAiTokenCost() above.
    aiTokenCost: billedAiTokenCost(aiUsageSummary),
    // The AI provider's rate as configured RIGHT NOW, for display/
    // reference on the Cost/Settings page only — not necessarily the rate
    // every session above was actually charged at, if it changed mid-period.
    aiTokenCurrentRate: aiProviderNow ? {
      key: aiProviderNow.key, label: aiProviderNow.label,
      ratePer1kTokens: aiProviderNow.ratePer1kTokens, tokenUnit: aiProviderNow.tokenUnit || 1000,
      taxPercent: aiProviderNow.taxPercent || 0,
    } : null,
  };
}

// Final, all-time billing snapshot for an org that's about to be deleted
// (see platform/admin.js's deleteOrganization). Deliberately does NOT call
// ensureCurrentPeriod — that resets aiMinutesUsed/phoneCharges to 0 once
// the rolling period lapses, which would corrupt the very figures we're
// trying to preserve if it ran right before archiving them. Reads the
// org's accrued counters as-is instead, and sums ai_session_usage
// all-time (no fromIso bound) rather than just the current period, since
// this is the last chance to capture that org's full cost history before
// its rows become unattributable (org_id with no organizations row to
// resolve a name from).
async function getFinalBillingSnapshot(orgId) {
  const org = await db.getOrg(orgId);
  if (!org) return null;

  const aiMinutesUsed = org.aiMinutesUsed || 0;
  const [costPerMinuteInr, aiMinutesCostInr, phoneCostPerMinute, aiUsageSummary, callProvider, phoneChargesSelfManaged] = await Promise.all([
    getCostPerMinuteInr(),
    costForMinutes(aiMinutesUsed),
    getPhoneCostPerMinute(),
    db.getAiUsageSummary(orgId, {}).catch(() => null), // no date bound — all-time
    costProviders.getProviderByKey("vobiz", "call").catch(() => null),
    isCallProviderSelfManaged(orgId, "vobiz"),
  ]);
  const aiProviderNow = await costProviders.getProviderByKey("gemini", "ai").catch(() => null);
  const phoneChargesBillable = await phoneChargesAreBillable(org, phoneChargesSelfManaged, { allTime: true });

  // Same locked-in-at-finalize-time sum as getBillingInfo — see
  // billedAiTokenCost() above.
  const aiTokenCost = billedAiTokenCost(aiUsageSummary);

  return {
    orgId,
    orgName: org.name || null,
    workspaceName: org.workspaceName || null,
    industry: org.industry || null,
    orgCreatedAt: org.createdAt || null,
    billingPeriodEnd: org.billingPeriodEnd || null,
    aiMinutesUsed,
    costPerMinuteInr,
    aiMinutesCostInr,
    phoneCharges: org.phoneCharges || 0,
    phoneCostPerMinute,
    phoneChargesBillable,
    callProvider: callProvider ? {
      key: callProvider.key, label: callProvider.label,
      rateUnit: callProvider.rateUnit, rateAmount: callProvider.rateAmount, taxPercent: callProvider.taxPercent || 0,
    } : null,
    aiTokenUsage: aiUsageSummary ? {
      totalTokens: aiUsageSummary.totalTokens,
      totalInputTokens: aiUsageSummary.totalInputTokens,
      totalOutputTokens: aiUsageSummary.totalOutputTokens,
      callCount: aiUsageSummary.callCount,
      sessionCount: aiUsageSummary.sessionCount,
    } : null,
    aiTokenCost,
    aiTokenCurrentRate: aiProviderNow ? {
      key: aiProviderNow.key, label: aiProviderNow.label,
      ratePer1kTokens: aiProviderNow.ratePer1kTokens, tokenUnit: aiProviderNow.tokenUnit || 1000,
      taxPercent: aiProviderNow.taxPercent || 0,
    } : null,
  };
}

module.exports = { ensureCurrentPeriod, getBillingInfo, getFinalBillingSnapshot, callRecordOwner, isCallProviderChargeBillable, phoneChargesAreBillable };
