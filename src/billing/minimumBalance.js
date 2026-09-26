const billingSettings = require("../platform/billingSettings");
const { orgBillingSettings } = require("./pricingResolver");

function normalizeIndustryKey(industry) {
  const key = String(industry || "").trim().toLowerCase();
  return key || "default";
}

async function getIndustryDefault(industry) {
  const map = await billingSettings.getIndustryMinimumBalanceMap();
  const key = normalizeIndustryKey(industry);
  const row = map[key] || map.default || billingSettings.DEFAULT_INDUSTRY_MINIMUMS.default;
  return {
    minimumBalanceInr: Number(row.minimumBalanceInr) || 20,
    reservationMinutes: Math.max(1, Number(row.reservationMinutes) || 3),
    source: "industry_default",
    industry: key,
  };
}

async function getEffectiveMinimumBalance(org) {
  const system = await billingSettings.getSystemMinimumBalance();
  const industryDefault = await getIndustryDefault(org?.industry);
  const override = orgBillingSettings(org).minimumBalance;
  if (!override || override.useIndustryDefault !== false) {
    return {
      ...industryDefault,
      effectiveMinimumBalanceInr: industryDefault.minimumBalanceInr,
      effectiveReservationMinutes: industryDefault.reservationMinutes,
      source: "industry_default",
    };
  }
  return {
    industry: industryDefault.industry,
    industryDefault,
    systemDefault: system,
    minimumBalanceInr: override.minimumBalanceInr ?? industryDefault.minimumBalanceInr,
    reservationMinutes: override.reservationMinutes ?? industryDefault.reservationMinutes,
    effectiveMinimumBalanceInr: override.minimumBalanceInr ?? industryDefault.minimumBalanceInr,
    effectiveReservationMinutes: override.reservationMinutes ?? industryDefault.reservationMinutes,
    source: "organization_override",
  };
}

module.exports = {
  getIndustryDefault,
  getEffectiveMinimumBalance,
};
