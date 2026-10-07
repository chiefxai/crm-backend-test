// ============================================================
// src/routes/config.js — /api/config/* endpoints
// ============================================================

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth, requirePermission } = require("../middleware/auth");
const { getConfigForOrg, updateConfigForOrg, PROMPT_PRESETS, buildIndustryPersona } = require("../config/agentConfig");
const db = require("../db/repository");
const auditLog = require("../platform/auditLog");
const aiTextReply = require("../ai/textReply");

// Voices available in Agent Studio's picker.
const AGENT_STUDIO_VOICES = ["Arjun", "Priya", "Dev", "Kavya"];

router.get("/", requireAuth, async (req, res) => {
  try {
    res.json(await getConfigForOrg(req.orgId));
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post("/", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const updated = await updateConfigForOrg(req.orgId, req.body);
    auditLog.record(req.orgId, req, "config.update", "config", null, req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get("/presets", requireAuth, async (req, res) => {
  try {
    const org = await require('../db/repositories/workspaceRepository').getProfile(req.orgId,req.workspaceId);
    res.json({ voices: AGENT_STUDIO_VOICES, presets: Object.keys(PROMPT_PRESETS), industry: org?.industry || null });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post("/preset", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!PROMPT_PRESETS[name]) return res.status(400).json({ error: `Unknown preset "${name}". Valid: ${Object.keys(PROMPT_PRESETS).join(", ")}` });
    const updated = await updateConfigForOrg(req.orgId, { systemPrompt: PROMPT_PRESETS[name] });
    auditLog.record(req.orgId, req, "config.apply_preset", "config", null, { preset: name });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Regenerate the AI persona from this org's industry + company profile.
router.post("/preset/industry", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const org = await require('../db/repositories/workspaceRepository').getProfile(req.orgId,req.workspaceId);
    const persona = buildIndustryPersona(org);
    const updated = await updateConfigForOrg(req.orgId, persona);
    auditLog.record(req.orgId, req, "config.apply_preset", "config", null, { preset: "industry", industry: org?.industry || null });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Test the agent persona with a one-off message without placing a real call.
router.post("/preview", requireAuth, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: "message is required" });
    const reply = await aiTextReply.generateReply({ orgId: req.orgId, history: [{ direction: "inbound", body: message }], customObjectsPromptSection: "" });
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
