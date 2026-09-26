// ============================================================
// src/platform/costProviders.js
//
// Super-admin-configurable rates for the call/AI providers this codebase
// actually integrates with — Vobiz for telephony, Gemini for both the
// live voice session and the post-call text agents (summary/sentiment/
// workflow-answers/follow-up). Each is billed per minute/hour (call) or
// per N tokens (AI), plus its own tax %.
//
// KNOWN_PROVIDERS below is the one place providers are DEFINED — a
// provider's key/kind/label come from code, not the admin UI. Adding
// support for a new provider (Twilio, OpenAI, whatever) is a one-line
// addition to that list; it then just shows up on the Cost page with a
// zero rate for a super admin to fill in — no "create provider" flow,
// no orphaned admin-typed providers with no code behind them. The admin
// UI (and upsertProvider below) can only ADJUST the rate/tax/active
// state of a provider that's already in KNOWN_PROVIDERS, never invent or
// remove one.
//
// Rate/tax overrides are stored as one JSON array under a single
// platform_settings key (same generic KV store platform/pricing.js and
// platform/featureFlags.js already use — see platform/settings.js), so
// no schema migration is needed when a provider's stored config changes.
//
// This is deliberately additive alongside platform/pricing.js's older
// flat "AI cost/min" and "phone cost/min" settings, not a replacement:
// - phoneCostForSeconds() in pricing.js is consulted first by
//   db.incrementPhoneCharges (call-minute accrual); it only overrides
//   the legacy flat phone rate once a super admin actually sets a rate
//   > 0 on the "vobiz" provider here. Until then, behavior is unchanged.
// - AI token cost (computeAiCost) is locked in per session at finalize
//   time (see ai/geminiUsageTracker.js) rather than recomputed live.
// ============================================================

const platformSettings = require("./settings");
const auditLog = require("./auditLog");

const PROVIDERS_KEY = "cost.providers";

const CALL_RATE_UNITS = ["minute", "hour"];

// The token count an AI rate is quoted per — admin-configurable per
// provider, same idea as CALL_RATE_UNITS above (per-minute vs per-hour).
// "1" lets an admin quote a genuine per-token rate for a cheap/high-
// volume model.
const AI_TOKEN_UNITS = [1, 100, 1000, 1000000];
const AI_TIME_UNITS = ["minute", "second"];
const DEFAULT_AI_TOKEN_UNIT = 1000;

// The only providers this codebase actually places calls/AI requests
// through today. rateAmount default for "vobiz" matches pricing.js's old
// DEFAULT_PHONE_COST_PER_MINUTE so nothing changes for orgs until a
// super admin actively edits it here. Every AI provider defaults its
// rate to 0 (no charge) rather than an invented number — an admin must
// explicitly price it for AI token cost to start showing anywhere.
const KNOWN_PROVIDERS = [
  {
    key: "vobiz", kind: "call", label: "Vobiz",
    defaults: { rateUnit: "minute", rateAmount: 8, taxPercent: 0 },
  },
  {
    key: "gemini", kind: "ai", label: "Gemini (Live Voice)",
    defaults: { pricingMode: "time", ratePer1kTokens: 0, tokenUnit: DEFAULT_AI_TOKEN_UNIT, timeRateAmount: 5, timeUnit: "minute", taxPercent: 0 },
  },
  {
    key: "gemini-postcall", kind: "ai", label: "Gemini (Post-Call Agents)",
    defaults: { pricingMode: "time", ratePer1kTokens: 0, tokenUnit: DEFAULT_AI_TOKEN_UNIT, timeRateAmount: 1, timeUnit: "minute", taxPercent: 0 },
  },
];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function getKnownProvider(key) {
  return KNOWN_PROVIDERS.find((p) => p.key === key) || null;
}

// Merges each KNOWN_PROVIDERS entry (fixed identity: key/kind/label) with
// whatever rate/tax/active override a super admin has saved for it —
// always returns exactly the known providers, in registry order, never
// more (a stored override for a provider no longer in code is silently
// dropped) or fewer (an entry with no override yet still appears, with
// its coded-in defaults, so it's visible and editable from day one).
async function listProviders() {
  const stored = await platformSettings.getSetting(PROVIDERS_KEY, null);
  const overridesByKey = new Map((Array.isArray(stored) ? stored : []).map((p) => [p.key, p]));

  return KNOWN_PROVIDERS.map(({ key, kind, label, defaults }) => {
    const o = overridesByKey.get(key);
    const provider = {
      key, kind, label,
      active: o?.active ?? true,
      taxPercent: o?.taxPercent ?? defaults.taxPercent,
      updatedAt: o?.updatedAt ?? null,
    };
    if (kind === "call") {
      provider.rateUnit = o?.rateUnit ?? defaults.rateUnit;
      provider.rateAmount = o?.rateAmount ?? defaults.rateAmount;
      provider.pricingVersion = o?.pricingVersion ?? null;
    } else {
      provider.pricingMode = o?.pricingMode ?? defaults.pricingMode ?? "time";
      provider.ratePer1kTokens = o?.ratePer1kTokens ?? defaults.ratePer1kTokens;
      provider.tokenUnit = o?.tokenUnit ?? defaults.tokenUnit;
      provider.timeRateAmount = o?.timeRateAmount ?? defaults.timeRateAmount ?? 0;
      provider.timeUnit = o?.timeUnit ?? defaults.timeUnit ?? "minute";
      provider.pricingVersion = o?.pricingVersion ?? null;
    }
    return provider;
  });
}

async function saveOverrides(list) {
  return platformSettings.setSetting(PROVIDERS_KEY, list);
}

async function getProviderByKey(key, kind) {
  const list = await listProviders();
  return list.find((p) => p.key === key && (!kind || p.kind === kind)) || null;
}

function sanitizeProviderInput(known, input, existingOverride) {
  const taxPercent = input.taxPercent !== undefined ? Number(input.taxPercent) : (existingOverride?.taxPercent ?? known.defaults.taxPercent);
  if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) {
    throw new Error("taxPercent must be a number between 0 and 100");
  }
  const active = input.active !== undefined ? !!input.active : (existingOverride?.active ?? true);
  const override = { key: known.key, active, taxPercent, updatedAt: new Date().toISOString() };

  if (known.kind === "call") {
    const rateUnit = input.rateUnit ?? existingOverride?.rateUnit ?? known.defaults.rateUnit;
    if (!CALL_RATE_UNITS.includes(rateUnit)) throw new Error(`rateUnit must be one of ${CALL_RATE_UNITS.join(", ")}`);
    const rateAmount = input.rateAmount !== undefined ? Number(input.rateAmount) : (existingOverride?.rateAmount ?? known.defaults.rateAmount);
    if (!Number.isFinite(rateAmount) || rateAmount < 0) throw new Error("rateAmount must be a non-negative number");
    override.rateUnit = rateUnit;
    override.rateAmount = rateAmount;
  } else {
    const pricingMode = input.pricingMode ?? existingOverride?.pricingMode ?? known.defaults.pricingMode ?? "token";
    if (!["token", "time"].includes(pricingMode)) throw new Error("pricingMode must be token or time");
    override.pricingMode = pricingMode;

    const ratePer1kTokens = input.ratePer1kTokens !== undefined ? Number(input.ratePer1kTokens) : (existingOverride?.ratePer1kTokens ?? known.defaults.ratePer1kTokens);
    if (!Number.isFinite(ratePer1kTokens) || ratePer1kTokens < 0) throw new Error("ratePer1kTokens must be a non-negative number");
    const tokenUnit = input.tokenUnit !== undefined ? Number(input.tokenUnit) : (existingOverride?.tokenUnit ?? known.defaults.tokenUnit);
    if (!AI_TOKEN_UNITS.includes(tokenUnit)) throw new Error(`tokenUnit must be one of ${AI_TOKEN_UNITS.join(", ")}`);
    override.ratePer1kTokens = ratePer1kTokens;
    override.tokenUnit = tokenUnit;

    const timeRateAmount = input.timeRateAmount !== undefined ? Number(input.timeRateAmount) : (existingOverride?.timeRateAmount ?? known.defaults.timeRateAmount ?? 0);
    if (!Number.isFinite(timeRateAmount) || timeRateAmount < 0) throw new Error("timeRateAmount must be a non-negative number");
    const timeUnit = input.timeUnit ?? existingOverride?.timeUnit ?? known.defaults.timeUnit ?? "minute";
    if (!AI_TIME_UNITS.includes(timeUnit)) throw new Error(`timeUnit must be one of ${AI_TIME_UNITS.join(", ")}`);
    override.timeRateAmount = timeRateAmount;
    override.timeUnit = timeUnit;
  }

  return override;
}

// Adjusts the rate/tax/active state of an EXISTING known provider —
// never creates or removes a provider (see KNOWN_PROVIDERS above).
async function upsertProvider(actor, input) {
  const key = String(input.key || "").trim().toLowerCase();
  const known = getKnownProvider(key);
  if (!known) {
    throw new Error(
      key
        ? `"${key}" is not a provider this codebase supports — providers are added in code (src/platform/costProviders.js), not from this page.`
        : "key is required"
    );
  }

  const stored = await platformSettings.getSetting(PROVIDERS_KEY, null);
  const list = Array.isArray(stored) ? stored : [];
  const idx = list.findIndex((p) => p.key === key);
  const updatedOverride = sanitizeProviderInput(known, input, idx >= 0 ? list[idx] : null);
  const prevVersion = idx >= 0 ? list[idx]?.pricingVersion : null;
  const versionDay = new Date().toISOString().slice(0, 10);
  const prevSeq = prevVersion && String(prevVersion).startsWith(versionDay) ? Number(String(prevVersion).split("-v")[1]) || 0 : 0;
  updatedOverride.pricingVersion = `${versionDay}-v${prevSeq + 1}`;
  const next = idx >= 0 ? list.map((p, i) => (i === idx ? updatedOverride : p)) : [...list, updatedOverride];
  await saveOverrides(next);
  await auditLog.record(null, actor, "platform.cost_provider.update", "cost_provider", key, { kind: known.kind });

  return (await listProviders()).find((p) => p.key === key);
}

// ── Cost calculation ────────────────────────────────────────────────

function applyTax(baseCost, taxPercent) {
  const tax = round2(baseCost * ((taxPercent || 0) / 100));
  return { baseCost: round2(baseCost), taxAmount: tax, totalCost: round2(baseCost + tax) };
}

/** Call-minute cost for a given provider (defaults to "vobiz", the only
 *  telephony provider today). Returns null if the provider isn't
 *  configured/active so callers can fall back to legacy flat pricing. */
function computeAiCostFromProvider(provider, { totalTokens = 0, durationSeconds = 0 } = {}) {
  if (!provider || !provider.active) return null;
  if ((provider.pricingMode ?? "token") === "time") {
    if (!provider.timeRateAmount) return null;
    const timeUnit = provider.timeUnit || "minute";
    const units = timeUnit === "second" ? (Number(durationSeconds) || 0) : ((Number(durationSeconds) || 0) / 60);
    const base = units * provider.timeRateAmount;
    const { baseCost, taxAmount, totalCost } = applyTax(base, provider.taxPercent);
    return {
      providerKey: provider.key, providerLabel: provider.label,
      pricingMode: "time", timeRateAmount: provider.timeRateAmount, timeUnit,
      pricingVersion: provider.pricingVersion || null,
      taxPercent: provider.taxPercent || 0, baseCost, taxAmount, totalCost,
    };
  }
  if (!provider.ratePer1kTokens) return null;
  const tokenUnit = provider.tokenUnit || DEFAULT_AI_TOKEN_UNIT;
  const base = ((Number(totalTokens) || 0) / tokenUnit) * provider.ratePer1kTokens;
  const { baseCost, taxAmount, totalCost } = applyTax(base, provider.taxPercent);
  return {
    providerKey: provider.key, providerLabel: provider.label,
    pricingMode: "token", ratePer1kTokens: provider.ratePer1kTokens, tokenUnit,
    pricingVersion: provider.pricingVersion || null,
    taxPercent: provider.taxPercent || 0, baseCost, taxAmount, totalCost,
  };
}

async function computeCallCost({ providerKey = "vobiz", seconds, providerSnapshot = null }) {
  const provider = providerSnapshot || await getProviderByKey(providerKey, "call");
  if (!provider || !provider.active || !provider.rateAmount) return null;
  const units = provider.rateUnit === "hour" ? (seconds || 0) / 3600 : (seconds || 0) / 60;
  const base = units * provider.rateAmount;
  const { baseCost, taxAmount, totalCost } = applyTax(base, provider.taxPercent);
  return {
    providerKey: provider.key, providerLabel: provider.label,
    rateUnit: provider.rateUnit, rateAmount: provider.rateAmount, taxPercent: provider.taxPercent || 0,
    pricingVersion: provider.pricingVersion || null,
    baseCost, taxAmount, totalCost,
  };
}

/** Token cost for a given AI provider (defaults to "gemini", the live
 *  voice session — pass "gemini-postcall" for the text-completion post-
 *  call agents). Returns null if not configured/active (e.g. rate never
 *  set by an admin). `tokenUnit` (1, 100, 1,000, or 1,000,000 tokens) is
 *  itself admin-configurable — ratePer1kTokens is "the rate, quoted per
 *  tokenUnit tokens" (field name kept for backward compatibility with
 *  already-stored providers/sessions, not literally "per 1,000" anymore
 *  unless tokenUnit is 1000). */
async function computeAiCost({ providerKey = "gemini", totalTokens = 0, durationSeconds = 0, orgId = null, providerSnapshot = null }) {
  let provider = providerSnapshot;
  if (!provider) {
    if (orgId) {
      try {
        const db = require("../db/repository");
        const { resolveAiProviderForBilling } = require("../billing/pricingResolver");
        const org = await db.getOrg(orgId);
        const role = providerKey === "gemini-postcall" ? "postCall" : "voice";
        const resolved = await resolveAiProviderForBilling(org, role);
        provider = resolved.provider;
      } catch {
        provider = await getProviderByKey(providerKey, "ai");
      }
    } else {
      provider = await getProviderByKey(providerKey, "ai");
    }
  }
  return computeAiCostFromProvider(provider, { totalTokens, durationSeconds });
}

/** The per-minute INR figure (tax included) that drives every org-facing
 *  "AI voice cost" display — Billing & Usage, Reports, Dashboard,
 *  Settings, etc. Sourced from the first active call-kind provider with a
 *  rate set (converted from an hourly rate if that's how it's quoted),
 *  never a separate manually-kept-in-sync number. There's only one call
 *  provider today (Vobiz); once a second is added, whichever is marked
 *  active becomes this figure automatically. Returns 0 if no call
 *  provider is active/priced. */
async function getPrimaryCallProviderRate() {
  const providers = await listProviders();
  const provider = providers.find((p) => p.kind === "call" && p.active && p.rateAmount > 0);
  if (!provider) return 0;
  const result = await computeCallCost({ providerKey: provider.key, seconds: 60 });
  return result ? result.totalCost : 0;
}

module.exports = {
  KNOWN_PROVIDERS,
  AI_TOKEN_UNITS,
  DEFAULT_AI_TOKEN_UNIT,
  listProviders,
  upsertProvider,
  getProviderByKey,
  computeCallCost,
  computeAiCost,
  computeAiCostFromProvider,
  getPrimaryCallProviderRate,
};
