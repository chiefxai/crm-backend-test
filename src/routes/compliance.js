// src/routes/compliance.js — /api/compliance/* endpoints

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth, requirePermission } = require("../middleware/auth");
const complianceEngine = require("../crm/complianceEngine");
const auditLog = require("../platform/auditLog");

router.get("/dnc", requireAuth, async (req, res) => {
  try { res.json(await complianceEngine.listDnc(req.orgId)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

router.post("/dnc", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const { phone, reason } = req.body || {};
    const entry = await complianceEngine.addToDnc(req.orgId, phone, reason);
    auditLog.record(req.orgId, req, "dnc.add", "dnc_entry", entry.id, { phone, reason });
    res.status(201).json(entry);
  } catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

router.delete("/dnc/:id", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    await complianceEngine.removeFromDnc(req.orgId, req.params.id);
    auditLog.record(req.orgId, req, "dnc.remove", "dnc_entry", req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

router.get("/calling-window", requireAuth, async (req, res) => {
  try { res.json(await complianceEngine.getCallingWindow(req.orgId)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

router.post("/calling-window", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const updated = await complianceEngine.updateCallingWindow(req.orgId, req.body || {});
    auditLog.record(req.orgId, req, "calling_window.update", "calling_window", null, req.body);
    res.json(updated);
  } catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
