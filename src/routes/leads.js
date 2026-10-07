// src/routes/leads.js — /api/leads, /api/enquiries, /api/loans

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth, requirePermission } = require("../middleware/auth");
const db = require("../db/repository");
const lendingObjectsMirror = require("../crm/lendingObjectsMirror");
const { parsePagination } = require("../lib/pagination");

// ── Leads ──
router.get("/", requireAuth, async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    res.json(await db.list("leads", req.orgId, pagination || {}));
  }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const newLead = await db.create("leads", req.orgId, req.body);
    global.broadcastLog(`👤 Created new lead: ${newLead.name} via UI`, { type: "lead", leadId: newLead.id });
    res.status(201).json(newLead);
    lendingObjectsMirror.mirrorLeadCreate(req.orgId, newLead);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const patch = { ...req.body };
    // Advance the universal contact->campaign->lead->opportunity->client
    // pipeline stage on a human qualification decision — same rule
    // db.replaceLeads applies for edits made via the debounced full-array
    // sync, kept in sync here for callers that PATCH a single lead
    // directly instead.
    if (patch.status === "Qualified") {
      const existing = await db.getLeadById(req.orgId, req.params.id).catch(() => null);
      if (existing?.pipelineStage !== "client") patch.pipelineStage = "opportunity";
    } else if (patch.status === "Converted") {
      patch.pipelineStage = "client";
    }
    const updated = await db.patch("leads", req.orgId, req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "Lead not found" });
    global.broadcastLog(`👤 Updated lead: ${updated.name}`, { type: "lead", leadId: req.params.id });
    res.json(updated);
    lendingObjectsMirror.mirrorLeadPatch(req.orgId, req.params.id, updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.delete("/:id", requireAuth, requirePermission("workspace.delete"), async (req, res) => {
  try {
    await db.remove("leads", req.orgId, req.params.id);
    global.broadcastLog(`👤 Removed lead: ${req.params.id}`, { type: "lead", leadId: req.params.id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/sync", requireAuth, async (req, res) => {
  try {
    const result = await db.replaceAll("leads", req.orgId, req.body);
    res.json(result);
    lendingObjectsMirror.mirrorReplaceAll(req.orgId, "leads", result);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
