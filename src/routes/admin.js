// src/routes/admin.js — audit-log, billing, metrics, SSE stream, broadcast, list-models

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth, requireSseTicket, createSseTicket, createWebSocketTicket, requireRole, ADMIN_ROLES } = require("../middleware/auth");
const auditLog = require("../platform/auditLog");
const billingEngine = require("../crm/billingEngine");
const { readAll } = require("../db/store");
const { addLogClient, removeLogClient, getActiveSessionsCount } = require("../shared");
const { parsePagination } = require("../lib/pagination");

router.get("/audit-log", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    res.json(await auditLog.list(req.orgId, pagination || {}));
  }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.get("/billing", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const info = await billingEngine.getBillingInfo(req.orgId);
    if (!info) return res.status(404).json({ error: "Organization not found" });
    res.json(info);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.get("/billing/console", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const billingConsole = require("../billing/billingConsole");
    const data = await billingConsole.getOrganizationBillingConsole(req.orgId);
    if (!data) return res.status(404).json({ error: "Organization not found" });
    res.json(data);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Legacy metrics from flat-file store — used by the demo kirana dashboard.
router.get("/metrics", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  // Legacy/demo metrics are global flat-file data, not tenant-scoped CRM data.
  // Keep this endpoint restricted to organization administrators until the
  // legacy dashboard is removed; do not expose these aggregate files to
  // ordinary organization members.
  const localCalls = readAll("calls_default", []);
  const totalCalls = localCalls.length;
  const totalDuration = localCalls.reduce((sum, c) => sum + (c.duration_seconds || 0), 0);
  const avgDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;
  const creditsConsumed = parseFloat(((totalDuration / 60) * 0.06).toFixed(2));
  const ordersList = readAll("orders_default", []);
  const todayRevenue = ordersList.filter(o => o.status === "Delivered" || o.status === "Confirmed").reduce((sum, o) => sum + (o.total || 0), 0);
  const totalOrders = ordersList.length;
  res.json({
    totalCalls, activeSessions: getActiveSessionsCount(), avgDuration, creditsConsumed,
    todayRevenue, totalOrders, avgOrderValue: totalOrders > 0 ? Math.round(todayRevenue / totalOrders) : 0,
    callSuccessRate: 78, repeatRate: 54
  });
});

// SSE endpoint — org-scoped live events.
router.post("/logs-stream/ticket", requireAuth, (req, res) => {
  try { res.json({ ticket: createSseTicket(req), expiresIn: 60 }); } catch (err) { res.status(503).json({ error: safeErrorMessage(err) }); }
});

// Short-lived ticket for browser voice WebSocket upgrades. Browsers cannot
// reliably attach Authorization headers during a WebSocket handshake.
router.post("/voice-session/ticket", requireAuth, (req, res) => {
  try { res.json({ ticket: createWebSocketTicket(req), expiresIn: 60 }); }
  catch (err) { res.status(503).json({ error: safeErrorMessage(err) }); }
});

router.get("/logs-stream", requireSseTicket, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString(), message: "Live event stream connected" })}\n\n`);
  const client = { res, orgId: req.orgId };
  addLogClient(client);
  req.on("close", () => removeLogClient(client));
});

// Stub for WhatsApp template broadcasts.
router.post("/broadcast", requireAuth, requireRole(ADMIN_ROLES), (req, res) => {
  const { audiencePhones, templateName } = req.body;
  global.broadcastLog(`📢 WhatsApp Broadcast (${templateName}) to ${audiencePhones?.length || 0} customers`, { type: "broadcast" });
  res.json({ sent: audiencePhones?.length || 0, failed: 0 });
});

// Lists Gemini models supporting bidiGenerateContent (live audio).
router.get("/list-models", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  // This endpoint uses the AI Studio REST API which requires an API key.
  // On Vertex AI (ADC) there is no API key, so return a descriptive response.
  if (!apiKey) return res.status(200).json({ note: "Model listing is only available when using Google AI Studio (GEMINI_API_KEY). This environment uses Vertex AI via ADC.", liveModels: [], allModelNames: [] });
  try {
    let allModels = [], pageToken = "";
    do {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const data = await fetch(url).then(r => r.json());
      if (data.models) allModels.push(...data.models);
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    const liveModels = allModels.filter(m => m.supportedGenerationMethods?.includes("bidiGenerateContent"));
    res.json({ totalModelsFound: allModels.length, liveModels: liveModels.map(m => ({ name: m.name, displayName: m.displayName, supportedGenerationMethods: m.supportedGenerationMethods })), allModelNames: allModels.map(m => m.name) });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
