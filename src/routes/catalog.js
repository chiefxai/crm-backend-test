// src/routes/catalog.js — orders, catalog, customers, khata, questions, lead-responses, chroma

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const db = require("../db/repository");
const { scopeForOrg } = require("../workspaces/scope");
const { createKhataPaymentService } = require("../crm/khataPayments");
const khataPaymentService = createKhataPaymentService(db.pool);
const { getLogger } = require("../observability/logger");
const log = getLogger("routes.catalog");

// ── Orders ──
router.get("/orders", requireAuth, async (req, res) => {
  try { res.json(await db.list("orders", req.orgId)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/orders", requireAuth, async (req, res) => {
  try {
    const order = await db.create("orders", req.orgId, {
      status: "Placed", source: "Manual",
      time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }), ...req.body
    });
    global.broadcastLog(`📦 New manual order placed: ${order.id} (Total: ₹${order.total})`, { type: "order", orderId: order.id });
    res.status(201).json(order);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/orders/:id/status", requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await db.patch("orders", req.orgId, req.params.id, { status });
    if (!order) return res.sendStatus(404);
    global.broadcastLog(`🔔 Order ${order.id} status updated to: ${status}`, { type: "order", orderId: order.id, status });
    res.json(order);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Catalog ──
router.get("/catalog", requireAuth, async (req, res) => {
  try { res.json(await db.list("catalog", req.orgId)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/catalog", requireAuth, async (req, res) => {
  try {
    const item = await db.create("catalog", req.orgId, req.body);
    global.broadcastLog(`🏷️ Added product: ${item.name} (${item.brand})`, { type: "catalog", itemId: item.id });
    res.status(201).json(item);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/catalog/:id", requireAuth, async (req, res) => {
  try {
    const updated = await db.patch("catalog", req.orgId, req.params.id, req.body);
    if (!updated) return res.sendStatus(404);
    global.broadcastLog(`🏷️ Updated product: ${updated.name}`, { type: "catalog", itemId: req.params.id });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Customers ──
router.get("/customers", requireAuth, async (req, res) => {
  try { res.json(await db.list("customers", req.orgId)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/customers", requireAuth, async (req, res) => {
  try {
    const c = await db.create("customers", req.orgId, { khata: Number(req.body.khata || 0), ltv: Number(req.body.ltv || 0), ...req.body });
    global.broadcastLog(`👤 Registered new customer: ${c.name} (${c.phone})`, { type: "customer", customerId: c.id });
    res.status(201).json(c);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.get("/customers/:id", requireAuth, async (req, res) => {
  try {
    const list = await db.list("customers", req.orgId);
    const c = list.find((x) => x.id === req.params.id);
    return c ? res.json(c) : res.sendStatus(404);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Khata (credit ledger) ──
router.post("/khata/:customerId/payment", requireAuth, async (req, res) => {
  try {
    const scope = scopeForOrg(req.orgId);
    const payment = await khataPaymentService.apply({
      orgId: req.orgId,
      workspaceId: scope.workspaceId,
      customerId: req.params.customerId,
      amount: req.body?.amount,
      idempotencyKey: req.get("Idempotency-Key") || req.body?.idempotencyKey,
    });
    const customer = payment.customer || (await db.list("customers", req.orgId)).find((x) => x.id === req.params.customerId);
    if (!customer) return res.sendStatus(404);
    if (!payment.replayed) {
      global.broadcastLog(`💳 Payment of ₹${payment.amount} for ${customer.name}. Khata: ₹${payment.balanceAfter}`, {
        type: "payment", customerId: req.params.customerId, orgId: req.orgId, workspaceId: scope.workspaceId,
      });
    }
    res.json({ ...customer, payment: { amount: payment.amount, balanceAfter: payment.balanceAfter, replayed: payment.replayed } });
  } catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

router.post("/khata/:customerId/reminder", requireAuth, async (req, res) => {
  try {
    const list = await db.list("customers", req.orgId);
    const c = list.find((x) => x.id === req.params.customerId);
    if (!c) return res.sendStatus(404);
    return res.status(501).json({ error: "Khata reminder delivery is not configured; no message was sent.", deliveryStatus: "not_configured", sent: false });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Questionnaire questions ──
router.get("/questions", requireAuth, async (req, res) => {
  try { res.json(await db.getQuestions(req.orgId)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/questions", requireAuth, async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Invalid questions payload" });
  try {
    const questions = await db.updateQuestions(req.orgId, req.body);
    global.broadcastLog(`⚙️ Questionnaire questions updated`, { type: "system" });
    res.json(questions);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Lead responses ──
router.get("/lead-responses", requireAuth, async (req, res) => {
  try {
    res.json(req.query.phone
      ? await db.getResponsesForPhone(req.orgId, req.query.phone)
      : await db.list("leadresponses", req.orgId));
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/lead-responses", requireAuth, async (req, res) => {
  try {
    const payload = await db.create("leadresponses", req.orgId, {
      callId: req.body.call_id || `call_local_${Date.now()}`,
      policyholderPhone: req.body.policyholder_phone || "",
      question: req.body.question, answer: req.body.answer
    });
    global.broadcastLog(`📝 Lead response: "${payload.question}" ➔ "${payload.answer}"`, { type: "system" });
    res.status(201).json(payload);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Chroma DB vector search proxy ──
// Vector-search proxy is application data access; require an authenticated org context.
router.get("/v2/chroma/search", requireAuth, async (req, res) => {
  const query = req.query.q || "";
  if (!query) return res.json({ documents: [], metadatas: [], ids: [] });
  try {
    const chromaUrl = process.env.CHROMA_URL || "http://chroma-db:8000";
    const collections = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`).then(r => r.json());
    const targetColl = collections.find(c => c.name === "policy-documents");
    if (!targetColl) throw new Error("policy-documents collection not found");

    const stopwords = new Set(["what","is","the","a","of","and","in","to","for","about","how","does","do","you","have","definition","qualifies","under","policy","wording","plan","insurance"]);
    const keywords = query.toLowerCase().replace(/[^a-z0-9\s]/g,"").split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));
    const expanded = keywords.flatMap(kw => [kw, kw.charAt(0).toUpperCase()+kw.slice(1), kw.toUpperCase()]);

    const filterBody = expanded.length === 0
      ? { where_document: { "$contains": query } }
      : expanded.length === 1
        ? { where_document: { "$contains": expanded[0] } }
        : { where_document: { "$or": expanded.map(kw => ({ "$contains": kw })) } };

    const data = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${targetColl.id}/get`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...filterBody, limit: 3, include: ["documents", "metadatas"] })
    }).then(r => r.json());
    res.json(data);
  } catch (err) {
    log.error("Chroma search proxy failed:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
