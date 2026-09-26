// Platform-wide billing defaults (Super Admin) — stored in platform_settings.
const platformSettings = require("./settings");

const KEYS = {
  globalAi: "billing.globalAi",
  industryMinimumBalance: "billing.industryMinimumBalance",
  systemMinimumBalance: "billing.systemMinimumBalance",
};

const DEFAULT_GLOBAL_AI = {
  pricingMode: "time",
  voice: { timeRateAmount: 5, timeUnit: "minute", inputTokenRate: 0, outputTokenRate: 0, tokenUnit: 1000 },
  postCall: { timeRateAmount: 1, timeUnit: "minute", inputTokenRate: 0, outputTokenRate: 0, tokenUnit: 1000 },
};

const DEFAULT_SYSTEM_MINIMUM = {
  minimumBalanceInr: 20,
  reservationMinutes: 3,
  source: "system_default",
};

const DEFAULT_INDUSTRY_MINIMUMS = {
  insurance: { minimumBalanceInr: 20, reservationMinutes: 3 },
  lending: { minimumBalanceInr: 25, reservationMinutes: 3 },
  default: { minimumBalanceInr: 20, reservationMinutes: 3 },
};

async function getGlobalAiDefaults() {
  const stored = await platformSettings.getSetting(KEYS.globalAi, null);
  if (!stored || typeof stored !== "object") return { ...DEFAULT_GLOBAL_AI, source: "system_default" };
  return {
    pricingMode: stored.pricingMode === "token" ? "token" : "time",
    voice: { ...DEFAULT_GLOBAL_AI.voice, ...(stored.voice || {}) },
    postCall: { ...DEFAULT_GLOBAL_AI.postCall, ...(stored.postCall || {}) },
    source: "global_default",
  };
}

async function setGlobalAiDefaults(actor, payload) {
  const next = {
    pricingMode: payload.pricingMode === "token" ? "token" : "time",
    voice: { ...DEFAULT_GLOBAL_AI.voice, ...(payload.voice || {}) },
    postCall: { ...DEFAULT_GLOBAL_AI.postCall, ...(payload.postCall || {}) },
    updatedAt: new Date().toISOString(),
  };
  await platformSettings.setSetting(KEYS.globalAi, next);
  return { ...next, source: "global_default" };
}

async function getIndustryMinimumBalanceMap() {
  const stored = await platformSettings.getSetting(KEYS.industryMinimumBalance, null);
  if (!stored || typeof stored !== "object") return { ...DEFAULT_INDUSTRY_MINIMUMS };
  return { ...DEFAULT_INDUSTRY_MINIMUMS, ...stored };
}

async function setIndustryMinimumBalanceMap(actor, map) {
  const next = { ...(map || {}), updatedAt: new Date().toISOString() };
  await platformSettings.setSetting(KEYS.industryMinimumBalance, next);
  return next;
}

async function getSystemMinimumBalance() {
  const stored = await platformSettings.getSetting(KEYS.systemMinimumBalance, null);
  if (!stored || typeof stored !== "object") return { ...DEFAULT_SYSTEM_MINIMUM };
  return { ...DEFAULT_SYSTEM_MINIMUM, ...stored, source: "system_default" };
}

module.exports = {
  KEYS,
  DEFAULT_GLOBAL_AI,
  DEFAULT_SYSTEM_MINIMUM,
  DEFAULT_INDUSTRY_MINIMUMS,
  getGlobalAiDefaults,
  setGlobalAiDefaults,
  getIndustryMinimumBalanceMap,
  setIndustryMinimumBalanceMap,
  getSystemMinimumBalance,
};
