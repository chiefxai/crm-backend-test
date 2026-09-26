// Effective AI + telephony pricing: organization override → global/platform → coded defaults.
const costProviders = require("../platform/costProviders");
const billingSettings = require("../platform/billingSettings");

const AI_PROVIDER_KEYS = {
  voice: "gemini",
  postCall: "gemini-postcall",
};

function orgBillingSettings(org) {
  const settings = org?.settings;
  if (!settings || typeof settings !== "object") return {};
  const billing = settings.billing;
  return billing && typeof billing === "object" ? billing : {};
}

function mergeAiOverride(globalAi, orgOverride) {
  if (!orgOverride || orgOverride.useGlobalDefault !== false) {
    return { config: globalAi, source: "global_default" };
  }
  const pricingMode = orgOverride.pricingMode === "token" ? "token" : (orgOverride.pricingMode || globalAi.pricingMode);
  return {
    source: "organization_override",
    config: {
      pricingMode,
      voice: { ...globalAi.voice, ...(orgOverride.voice || {}) },
      postCall: { ...globalAi.postCall, ...(orgOverride.postCall || {}) },
    },
  };
}

async function getEffectiveAiPricing(org) {
  const globalAi = await billingSettings.getGlobalAiDefaults();
  const override = orgBillingSettings(org).aiPricing;
  const { config, source } = mergeAiOverride(globalAi, override);
  return {
    pricingMode: config.pricingMode === "token" ? "TOKEN_BASED" : "TIME_BASED",
    pricingModeRaw: config.pricingMode,
    source,
    voice: config.voice,
    postCall: config.postCall,
  };
}

// Map effective AI config onto costProviders provider shape for computeAiCost.
function effectiveProviderFromAiConfig(role, effective, platformProvider) {
  const slice = role === "postCall" ? effective.postCall : effective.voice;
  const pricingMode = effective.pricingModeRaw === "token" ? "token" : "time";
  return {
    ...platformProvider,
    active: platformProvider?.active ?? true,
    pricingMode,
    timeRateAmount: slice.timeRateAmount ?? platformProvider?.timeRateAmount ?? 0,
    timeUnit: slice.timeUnit || platformProvider?.timeUnit || "minute",
    ratePer1kTokens: slice.inputTokenRate ?? slice.ratePer1kTokens ?? platformProvider?.ratePer1kTokens ?? 0,
    tokenUnit: slice.tokenUnit || platformProvider?.tokenUnit || 1000,
    taxPercent: platformProvider?.taxPercent ?? 0,
    pricingVersion: platformProvider?.pricingVersion || null,
  };
}

async function resolveAiProviderForBilling(org, role) {
  const key = role === "postCall" ? AI_PROVIDER_KEYS.postCall : AI_PROVIDER_KEYS.voice;
  const [effective, platformProvider] = await Promise.all([
    getEffectiveAiPricing(org),
    costProviders.getProviderByKey(key, "ai"),
  ]);
  return {
    key,
    effective,
    provider: effectiveProviderFromAiConfig(role, effective, platformProvider),
  };
}

async function resolveCallProviderPricing(providerKey = "vobiz", org = null) {
  const provider = await costProviders.getProviderByKey(providerKey, "call");
  if (!provider) return null;
  const orgProviderOverride = org ? orgBillingSettings(org).providerOverrides?.[providerKey] : null;
  if (!orgProviderOverride || orgProviderOverride.useGlobalDefault !== false) {
    return { provider, source: "provider_default" };
  }
  return {
    source: "organization_override",
    provider: {
      ...provider,
      rateAmount: orgProviderOverride.rateAmount ?? provider.rateAmount,
      rateUnit: orgProviderOverride.rateUnit ?? provider.rateUnit,
      taxPercent: orgProviderOverride.taxPercent ?? provider.taxPercent,
    },
  };
}

module.exports = {
  AI_PROVIDER_KEYS,
  orgBillingSettings,
  mergeAiOverride,
  getEffectiveAiPricing,
  resolveAiProviderForBilling,
  resolveCallProviderPricing,
  effectiveProviderFromAiConfig,
};
