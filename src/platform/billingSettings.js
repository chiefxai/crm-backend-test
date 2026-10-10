// Platform-wide billing defaults (Super Admin) — stored in platform_settings.
const platformSettings = require("./settings");

const KEYS = {
  globalAi: "billing.globalAi",
  industryMinimumBalance: "billing.industryMinimumBalance",
  systemMinimumBalance: "billing.systemMinimumBalance",
  workspacePlans: "billing.workspacePlans",
};

const DEFAULT_WORKSPACE_PLANS = Object.freeze({
  version: 1,
  plans: [
    { id: "starter", name: "Starter", active: true, defaultMode: "single", pricing: { baseMonthlyInr: null, includedWorkspaces: 1, additionalIndustryMonthlyInr: 0, monthlySubscriptionCreditsInr: 0 } },
    { id: "growth", name: "Growth", active: true, defaultMode: "single", pricing: { baseMonthlyInr: null, includedWorkspaces: 1, additionalIndustryMonthlyInr: 0, monthlySubscriptionCreditsInr: 0 } },
    { id: "enterprise", name: "Enterprise", active: true, defaultMode: "single", pricing: { baseMonthlyInr: null, includedWorkspaces: 1, additionalIndustryMonthlyInr: 0, monthlySubscriptionCreditsInr: 0 } },
  ],
});

const WORKSPACE_PLAN_MODES = new Set(["single", "same_industry", "mixed_industry"]);

function normalizeWorkspacePlans(input, currentVersion, policyCatalog = null) {
  if (!input || typeof input !== "object" || !Array.isArray(input.plans) || input.plans.length < 1 || input.plans.length > 100) {
    throw Object.assign(new Error("Provide between 1 and 100 workspace plans."), { statusCode: 400 });
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== currentVersion) {
    throw Object.assign(new Error("Workspace plan settings changed. Refresh before saving."), { statusCode: 409, code: "VERSION_CONFLICT" });
  }
  const ids = new Set();
  const names = new Set();
  const plans = input.plans.map((plan, index) => {
    const path = `Plan ${index + 1}`;
    const id = String(plan?.id || "").trim().toLowerCase();
    const name = String(plan?.name || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw Object.assign(new Error(`${path} has an invalid plan ID.`), { statusCode: 400 });
    if (!name || name.length > 80) throw Object.assign(new Error(`${path} name must contain 1 to 80 characters.`), { statusCode: 400 });
    if (ids.has(id) || names.has(name.toLowerCase())) throw Object.assign(new Error("Plan IDs and names must be unique."), { statusCode: 400 });
    if (typeof plan.active !== "boolean" || !WORKSPACE_PLAN_MODES.has(plan.defaultMode)) throw Object.assign(new Error(`${path} has invalid status or workspace mode.`), { statusCode: 400 });
    const pricing = plan.pricing || {};
    const money = (value, label, optional = false) => {
      if (optional && value == null) return null;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100000000 || Math.round(value * 100) / 100 !== value) {
        throw Object.assign(new Error(`${path} ${label} must be an INR amount with at most two decimal places.`), { statusCode: 400 });
      }
      return value;
    };
    const includedWorkspaces = plan.defaultMode === "single" ? 1 : pricing.includedWorkspaces;
    if (!Number.isInteger(includedWorkspaces) || includedWorkspaces < 1 || includedWorkspaces > 1000) {
      throw Object.assign(new Error(`${path} included workspaces must be between 1 and 1000 for multi-workspace plans.`), { statusCode: 400 });
    }
    // Legacy workspace plans without a policy link inherit the platform default
    // on their next save. Explicit links must refer to an existing template.
    const policyId = plan.retentionPolicyId == null || plan.retentionPolicyId === ""
      ? (policyCatalog?.defaultPolicyId || null) : String(plan.retentionPolicyId).trim();
    if (policyId && policyCatalog && !policyCatalog.policies.some(policy => policy.id === policyId)) {
      throw Object.assign(new Error(`${path} retention and backup policy no longer exists. Refresh policies before saving.`),
        { statusCode: 409 });
    }
    ids.add(id); names.add(name.toLowerCase());
    return {
      id, name, active: plan.active, defaultMode: plan.defaultMode,
      retentionPolicyId: policyId,
      pricing: {
        baseMonthlyInr: money(pricing.baseMonthlyInr, "organization monthly price", true),
        includedWorkspaces,
        additionalIndustryMonthlyInr: money(pricing.additionalIndustryMonthlyInr, "additional industry monthly price"),
        monthlySubscriptionCreditsInr: money(pricing.monthlySubscriptionCreditsInr ?? 0, "monthly subscription credits"),
      },
    };
  });
  if (!plans.some((plan) => plan.active)) throw Object.assign(new Error("At least one workspace plan must remain active."), { statusCode: 400 });
  const priorIds = new Set((input.priorPlanIds || []).map(String));
  if ([...priorIds].some((id) => !ids.has(id))) throw Object.assign(new Error("Existing plans cannot be deleted. Archive plans that should no longer be offered."), { statusCode: 400 });
  return plans;
}

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

async function getWorkspacePlans() {
  const stored = await platformSettings.getSetting(KEYS.workspacePlans, null);
  if (!stored || !Array.isArray(stored.plans)) return DEFAULT_WORKSPACE_PLANS;
  return { version: Number(stored.version) || 1, plans: stored.plans };
}

async function setWorkspacePlans(actor, input) {
  const current = await getWorkspacePlans();
  const policyCatalog = await require("./dataRetention").getPolicyCatalog();
  const plans = normalizeWorkspacePlans(
    { ...input, priorPlanIds: current.plans.map(plan => plan.id) },
    current.version, policyCatalog,
  );
  const next = { version: current.version + 1, plans, updatedAt: new Date().toISOString(), updatedBy: actor?.userId || null };
  await platformSettings.setSetting(KEYS.workspacePlans, next);
  return next;
}

module.exports = {
  KEYS,
  DEFAULT_WORKSPACE_PLANS,
  DEFAULT_GLOBAL_AI,
  DEFAULT_SYSTEM_MINIMUM,
  DEFAULT_INDUSTRY_MINIMUMS,
  getGlobalAiDefaults,
  setGlobalAiDefaults,
  getIndustryMinimumBalanceMap,
  setIndustryMinimumBalanceMap,
  getSystemMinimumBalance,
  getWorkspacePlans,
  setWorkspacePlans,
  normalizeWorkspacePlans,
};
