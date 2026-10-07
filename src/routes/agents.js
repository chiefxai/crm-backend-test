// src/routes/agents.js — /api/agents CRUD
const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth, requirePermission } = require("../middleware/auth");
const db = require("../db/repository");
const auditLog = require("../platform/auditLog");
const knowledgeBase = require("../ai/knowledgeBase");
const { getLogger } = require("../observability/logger");
const { parsePagination } = require("../lib/pagination");
const { buildFinalPrompt, CALL_TYPES } = require("../config/promptTemplates");
const { getVoicePrompt, getPromptCatalog, getLanguagePrompt, getDialectPrompt } = require("../platform/prompts");
const { DIALECT_PROFILES, getSupportedLanguages, getDialectsForLanguage } = require("../config/dialectProfiles");
const log = getLogger("routes.agents");

// Guards against an agent referencing another org's knowledge base
// documents (or ids that don't exist at all).
async function validateKnowledgeBaseDocumentIds(orgId, mode, documentIds) {
  if (mode !== "specific" || !documentIds?.length) return null;
  const orgDocIds = new Set((await knowledgeBase.listDocuments(orgId)).map((d) => d.id));
  const invalid = documentIds.filter((id) => !orgDocIds.has(id));
  if (invalid.length) return `Unknown document id(s): ${invalid.join(", ")}`;
  return null;
}

// GET /api/agents — list all agents for the org, with phone number assignments
router.get("/", requireAuth, async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const [agentResult, numbers] = await Promise.all([
      db.listAgents(req.orgId, pagination || {}),
      db.listNumbersWithAgent(req.orgId),
    ]);
    const agents = pagination ? agentResult.rows : agentResult;
    // Attach inbound number (exclusive) and outbound number (shared) to each agent
    const result = agents.map((a) => ({
      ...a,
      assignedNumber:  numbers.find((n) => n.agent_id === a.id) || null,
      outboundNumber:  a.outboundNumberId ? (numbers.find((n) => n.id === a.outboundNumberId) || null) : null,
    }));
    res.json(pagination ? { rows: result, total: agentResult.total } : result);
  } catch (err) {
    log.error("[agents] listAgents error:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/agents — create a new agent
router.post("/", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const {
      name, systemPrompt, activeVoice, emotion, speed, friendliness, language,
      industry, dialect, businessContext, callType,
      knowledgeBaseMode, knowledgeBaseDocumentIds,
    } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });
    const kbErr = await validateKnowledgeBaseDocumentIds(req.orgId, knowledgeBaseMode, knowledgeBaseDocumentIds);
    if (kbErr) return res.status(400).json({ error: kbErr });
    const agent = await db.createAgent(req.orgId, {
      name: name.trim(), systemPrompt, activeVoice, emotion, speed, friendliness, language,
      industry, dialect, businessContext, callType,
      knowledgeBaseMode, knowledgeBaseDocumentIds,
    });
    auditLog.record(req.orgId, req, "agent.create", "agent", agent.id, { name });
    res.status(201).json(agent);
  } catch (err) {
    log.error("[agents] createAgent error:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/agents/prompt-config — single source of truth for the Agent
// Studio form: supported languages, their dialects (with profile/examples),
// and valid call types. Frontend must not hardcode this list separately.
router.get("/prompt-config", requireAuth, async (req, res) => {
  res.json({
    ...await getPromptCatalog(),
    callTypes: CALL_TYPES,
  });
});

// POST /api/agents/generate-prompt — assemble the final voice-agent system
// prompt from the two master prompts (INBOUND/OUTBOUND) + dynamic variables.
// Does not persist anything; the frontend previews the result and saves it
// via POST/PUT /api/agents as that agent's systemPrompt, same as any other
// hand-written prompt would flow through buildRuntimePrompt at call time.
router.post("/generate-prompt", requireAuth, async (req, res) => {
  try {
    const { agentName, companyName, industry, language, dialect, businessContext, callType } = req.body || {};
    if (!callType || !CALL_TYPES.includes(String(callType).toUpperCase())) {
      return res.status(400).json({ error: `callType is required and must be one of ${CALL_TYPES.join(", ")}` });
    }
    const catalog = await getPromptCatalog();
    const configuredLanguage = catalog.languages.find((x) => x.language === language);
    if (language && !configuredLanguage) {
      return res.status(400).json({ error: `"${language}" is not a configured language` });
    }
    const configuredDialect = language && dialect
      ? (catalog.dialectsByLanguage[language] || []).find((x) => x.dialect === dialect)
      : null;
    if (language && dialect && !configuredDialect) {
      return res.status(400).json({ error: `"${dialect}" is not a configured dialect for language "${language}"` });
    }
    let resolvedCompanyName = companyName;
    if (!resolvedCompanyName) {
      const org = await db.getOrg(req.orgId);
      resolvedCompanyName = org?.name;
    }
    const voicePrompt = await getVoicePrompt(callType);
    const prompt = buildFinalPrompt({
      agentName, companyName: resolvedCompanyName, industry, language, dialect, businessContext, callType,
    }, voicePrompt.prompt, {
      languagePrompt: configuredLanguage?.prompt,
      dialect: configuredDialect || null,
      dialectPrompt: configuredDialect?.prompt,
      dialectExamples: configuredDialect?.examples,
    });
    res.json({ prompt });
  } catch (err) {
    log.error("[agents] generate-prompt error:", err.message);
    res.status(400).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/agents/system — the built-in post-call AI agents (sentiment,
// summary, workflow-answer extraction, follow-up safety net), shown
// alongside user-created ones in Agent Studio, each with this org's
// customized system prompt where one has been saved. Registered BEFORE
// GET /:id so "system" is never swallowed as an :id param.
router.get("/system", requireAuth, async (req, res) => {
  const { getEffectiveSystemAgents } = require("../ai/systemAgents");
  try {
    res.json(await getEffectiveSystemAgents(req.orgId));
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PUT /api/agents/system/:id — saves (or, given a blank/default-matching
// value, clears) this org's override for one system agent's prompt.
router.put("/system/:id", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  const { setPromptOverride } = require("../ai/systemAgents");
  try {
    const updated = await setPromptOverride(req.orgId, req.params.id, req.body?.systemPrompt);
    auditLog.record(req.orgId, req, "system_agent.update_prompt", "system_agent", req.params.id, {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/agents/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const agent = await db.getAgent(req.params.id, req.orgId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(agent);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PUT /api/agents/:id — update agent settings
router.put("/:id", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const agent = await db.getAgent(req.params.id, req.orgId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const kbErr = await validateKnowledgeBaseDocumentIds(req.orgId, req.body?.knowledgeBaseMode, req.body?.knowledgeBaseDocumentIds);
    if (kbErr) return res.status(400).json({ error: kbErr });
    const updated = await db.updateAgent(req.params.id, req.orgId, req.body);
    auditLog.record(req.orgId, req, "agent.update", "agent", req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    log.error("[agents] updateAgent error:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PATCH /api/agents/:id/active — enable/disable an agent
// body: { active: boolean }
// Disabled agents are skipped by inbound call routing and hidden from
// outbound agent pickers (Voice Simulator wizard).
router.patch("/:id/active", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const { active } = req.body || {};
    if (typeof active !== "boolean") return res.status(400).json({ error: "active (boolean) is required" });
    const agent = await db.getAgent(req.params.id, req.orgId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const updated = await db.setAgentActive(req.params.id, req.orgId, active);
    auditLog.record(req.orgId, req, "agent.set_active", "agent", req.params.id, { active });
    res.json(updated);
  } catch (err) {
    log.error("[agents] setAgentActive error:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// DELETE /api/agents/:id
router.delete("/:id", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const agent = await db.getAgent(req.params.id, req.orgId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    await db.deleteAgent(req.params.id, req.orgId);
    auditLog.record(req.orgId, req, "agent.delete", "agent", req.params.id, { name: agent.name });
    res.json({ success: true });
  } catch (err) {
    log.error("[agents] deleteAgent error:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PUT /api/agents/:id/assign-outbound-number
// body: { numberId: "uuid" | null }
// Many agents may share the same outbound number — no exclusivity enforced.
router.put("/:id/assign-outbound-number", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const { numberId } = req.body || {};
    const agent = await db.getAgent(req.params.id, req.orgId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    if (numberId) {
      const numbers = await db.listNumbersWithAgent(req.orgId);
      if (!numbers.find((n) => n.id === numberId))
        return res.status(400).json({ error: "Phone number not found in this org" });
    }

    await db.assignAgentOutboundNumber(req.params.id, numberId || null, req.orgId);
    auditLog.record(req.orgId, req, "agent.assign_outbound_number", "agent", req.params.id, { numberId });
    res.json({ success: true, agentId: req.params.id, numberId: numberId || null });
  } catch (err) {
    log.error("[agents] assignAgentOutboundNumber error:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PUT /api/agents/:id/assign-number
// body: { numberId: "uuid" | null }
// numberId null = unassign all numbers from this agent
router.put("/:id/assign-number", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const { numberId } = req.body || {};
    const agent = await db.getAgent(req.params.id, req.orgId);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    // If assigning, verify the number belongs to this org
    if (numberId) {
      const numbers = await db.listNumbersWithAgent(req.orgId);
      const num = numbers.find((n) => n.id === numberId);
      if (!num) return res.status(400).json({ error: "Phone number not found in this org" });
    }

    await db.assignAgentToNumber(req.params.id, numberId || null, req.orgId);
    auditLog.record(req.orgId, req, "agent.assign_number", "agent", req.params.id, { numberId });
    res.json({ success: true, agentId: req.params.id, numberId: numberId || null });
  } catch (err) {
    log.error("[agents] assignAgentToNumber error:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
