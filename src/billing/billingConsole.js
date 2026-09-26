const db = require("../db/repository");
const rechargeBilling = require("../crm/rechargeBilling");
const { getOrgServiceProfile } = require("./orgServices");
const { getEffectiveAiPricing, orgBillingSettings } = require("./pricingResolver");
const { getEffectiveMinimumBalance, getIndustryDefault } = require("./minimumBalance");
const { getCurrentBillingPeriod } = require("./billingPeriod");
const billingSettings = require("../platform/billingSettings");

async function sumCallBillingForPeriod(orgId, startIso, endIso) {
  const rows = await db.list("callbillingrecords", orgId);
  const start = startIso ? new Date(startIso).getTime() : 0;
  const end = endIso ? new Date(endIso).getTime() : Infinity;
  let ai = 0;
  let phone = 0;
  let total = 0;
  let count = 0;
  const byProvider = {};
  for (const row of rows) {
    const t = new Date(row.createdAt || 0).getTime();
    if (t < start || t >= end) continue;
    count += 1;
    ai += Number(row.aiCostInr) || 0;
    phone += Number(row.providerCostInr) || 0;
    total += Number(row.totalCostInr) || 0;
    const pk = row.telephonyProvider || "unknown";
    if (!byProvider[pk]) byProvider[pk] = { provider: pk, calls: 0, durationSeconds: 0, providerCostInr: 0 };
    byProvider[pk].calls += 1;
    byProvider[pk].durationSeconds += Number(row.durationSeconds) || 0;
    byProvider[pk].providerCostInr += Number(row.providerCostInr) || 0;
  }
  return {
    callCount: count,
    aiSpendInr: round2(ai),
    phoneSpendInr: round2(phone),
    totalSpendInr: round2(total),
    byProvider: Object.values(byProvider).map((p) => ({ ...p, providerCostInr: round2(p.providerCostInr) })),
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function getOrganizationBillingConsole(orgId) {
  const org = await db.getOrg(orgId);
  if (!org) return null;

  const services = getOrgServiceProfile(org);
  const billingMethod = rechargeBilling.normalizeBillingMethod(org.billingMethod);
  const period = getCurrentBillingPeriod(org);
  const periodSpend = await sumCallBillingForPeriod(orgId, period.startIso, period.endIso);

  const [effectiveAi, globalAi, minimumBalance, industryDefault, wallet] = await Promise.all([
    getEffectiveAiPricing(org),
    billingSettings.getGlobalAiDefaults(),
    getEffectiveMinimumBalance(org),
    getIndustryDefault(org.industry),
    billingMethod === "recharge_based" ? rechargeBilling.getBillingState(orgId) : null,
  ]);

  const ledger = await db.list("billingledgerentries", orgId);
  const usageRows = await db.list("callbillingrecords", orgId);
  const usageRowsLimited = usageRows.slice(0, 200);

  const overview = billingMethod === "recharge_based" && wallet
    ? {
        billingMethod,
        currentBalanceInr: wallet.balanceInr,
        reservedInr: wallet.reservedInr,
        availableInr: wallet.availableInr,
        currentMonthSpendInr: periodSpend.totalSpendInr,
      }
    : {
        billingMethod,
        currentMonthSpendInr: periodSpend.totalSpendInr,
        aiSpendInr: periodSpend.aiSpendInr,
        phoneSpendInr: periodSpend.phoneSpendInr,
        totalCalls: periodSpend.callCount,
        billingPeriod: period,
      };

  return {
    orgId,
    services,
    overview,
    billingPeriod: period,
    aiBilling: services.aiEnabled ? {
      pricingMode: effectiveAi.pricingMode,
      source: effectiveAi.source,
      globalDefault: globalAi,
      effective: effectiveAi,
      organizationOverride: orgBillingSettings(org).aiPricing || null,
    } : null,
    phoneBilling: services.phoneEnabled ? {
      providers: periodSpend.byProvider,
      currentMonthPhoneSpendInr: periodSpend.phoneSpendInr,
      note: "Per-minute telephony cost is provider-specific; historical calls store the rate snapshot on each call billing record.",
    } : null,
    minimumCallBalance: {
      industry: org.industry,
      industryDefault,
      organizationOverride: orgBillingSettings(org).minimumBalance || null,
      effective: minimumBalance,
    },
    usageAndCost: usageRowsLimited,
    ledger: ledger.slice(0, 200),
    configuration: {
      chargeScope: services.chargeScope,
      billingMethod,
      timezone: period.timeZone,
    },
  };
}

module.exports = {
  getOrganizationBillingConsole,
  sumCallBillingForPeriod,
};
