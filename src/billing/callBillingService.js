const crypto = require("crypto");
const db = require("../db/repository");
const costProviders = require("../platform/costProviders");
const { getOrgServiceProfile } = require("./orgServices");
const { resolveCallProviderPricing } = require("./pricingResolver");
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function sumAiSessionCostsForCall(orgId, callId) {
  if (!orgId || !callId) return { voiceCostInr: 0, postCallCostInr: 0, totalAiCostInr: 0, sessions: [] };
  const sessions = await db.list("aisessionusage", orgId, { callId });
  let voice = 0;
  let post = 0;
  for (const s of sessions) {
    const amt = Number(s.platformTotalCostInr) || 0;
    if (s.platformCostProviderKey === "gemini-postcall") post += amt;
    else voice += amt;
  }
  return {
    voiceCostInr: round2(voice),
    postCallCostInr: round2(post),
    totalAiCostInr: round2(voice + post),
    sessions,
  };
}

async function computeCallBillingBreakdown({ org, providerKey = "vobiz", durationSeconds = 0, callId = null }) {
  const services = getOrgServiceProfile(org);
  const aiCosts = callId ? await sumAiSessionCostsForCall(org.id, callId) : { voiceCostInr: 0, postCallCostInr: 0, totalAiCostInr: 0, sessions: [] };

  let providerCost = null;
  let phoneNumberCostInr = 0;
  if (services.phoneEnabled) {
    const resolved = await resolveCallProviderPricing(providerKey, org);
    const provider = resolved?.provider;
    if (provider?.active && provider.rateAmount) {
      providerCost = await costProviders.computeCallCost({ providerKey, seconds: durationSeconds, providerSnapshot: provider });
    }
  }

  const providerTotal = providerCost ? round2(providerCost.totalCost) : 0;
  const totalCostInr = round2(
    (services.aiEnabled ? aiCosts.totalAiCostInr : 0)
    + (services.phoneEnabled ? providerTotal : 0)
    + phoneNumberCostInr
  );

  const pricingMode = aiCosts.sessions[0]?.platformPricingMode
    ? (aiCosts.sessions[0].platformPricingMode === "token" ? "TOKEN_BASED" : "TIME_BASED")
    : null;

  return {
    services,
    durationSeconds: Number(durationSeconds) || 0,
    pricingMode,
    voiceAgentCostInr: services.aiEnabled ? aiCosts.voiceCostInr : 0,
    postCallAgentCostInr: services.aiEnabled ? aiCosts.postCallCostInr : 0,
    aiCostInr: services.aiEnabled ? aiCosts.totalAiCostInr : 0,
    telephonyProvider: services.phoneEnabled ? providerKey : null,
    providerPricingVersion: providerCost?.pricingVersion || null,
    providerRateAmount: providerCost?.rateAmount ?? null,
    providerRateUnit: providerCost?.rateUnit ?? null,
    providerCostInr: services.phoneEnabled ? providerTotal : 0,
    phoneNumberCostInr,
    totalCostInr,
    providerCostDetail: providerCost,
    aiSessions: aiCosts.sessions,
  };
}

async function recordCallBilling({ orgId, callId, providerKey = "vobiz", durationSeconds = 0, billingMethod = null }) {
  const org = await db.getOrg(orgId);
  if (!org || !callId) return null;

  const breakdown = await computeCallBillingBreakdown({
    org,
    providerKey,
    durationSeconds,
    callId,
  });

  const existing = await db.list("callbillingrecords", orgId, { callId });
  const payload = {
    callId,
    durationSeconds: breakdown.durationSeconds,
    billingMethod: billingMethod || org.billingMethod || "pay_as_you_go",
    pricingMode: breakdown.pricingMode,
    voiceAgentCostInr: breakdown.voiceAgentCostInr,
    postCallAgentCostInr: breakdown.postCallAgentCostInr,
    aiCostInr: breakdown.aiCostInr,
    telephonyProvider: breakdown.telephonyProvider,
    providerPricingVersion: breakdown.providerPricingVersion,
    providerRateAmount: breakdown.providerRateAmount,
    providerRateUnit: breakdown.providerRateUnit,
    providerCostInr: breakdown.providerCostInr,
    phoneNumberCostInr: breakdown.phoneNumberCostInr,
    totalCostInr: breakdown.totalCostInr,
    snapshot: breakdown,
  };
  if (existing.length > 0) {
    return db.patch("callbillingrecords", orgId, existing[0].id, payload);
  }
  const id = crypto.randomUUID();
  return db.create("callbillingrecords", orgId, {
    id,
    ...payload,
    createdAt: new Date().toISOString(),
  });
}

module.exports = {
  sumAiSessionCostsForCall,
  computeCallBillingBreakdown,
  recordCallBilling,
};
