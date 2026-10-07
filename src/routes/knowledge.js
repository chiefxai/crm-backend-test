// src/routes/knowledge.js — /api/knowledge/* endpoints

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const multer = require("multer");
const { requireAuth, requirePermission } = require("../middleware/auth");
const knowledgeBase = require("../ai/knowledgeBase");
const documentParser = require("../utils/documentParser");
const auditLog = require("../platform/auditLog");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Wrap multer so upload errors return the standard {error} JSON shape.
function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: safeErrorMessage(err) });
    next();
  });
}

router.get("/documents", requireAuth, async (req, res) => {
  try { res.json(await knowledgeBase.listDocuments(req.orgId)); }
  catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

router.post("/documents", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    const { title, text } = req.body || {};
    const doc = await knowledgeBase.addDocument(req.orgId, title, text);
    auditLog.record(req.orgId, req, "knowledge.add_document", "knowledge_document", doc.id, { title });
    res.status(201).json(doc);
  } catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

router.post("/documents/upload", requireAuth, requirePermission("workspace.settings.manage"), handleUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const text = await documentParser.extractText(req.file.originalname, req.file.buffer);
    const title = (req.body?.title || "").trim() || req.file.originalname.replace(/\.[^.]+$/, "");
    const doc = await knowledgeBase.addDocument(req.orgId, title, text);
    auditLog.record(req.orgId, req, "knowledge.add_document", "knowledge_document", doc.id, { title, sourceFile: req.file.originalname });
    res.status(201).json(doc);
  } catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

router.delete("/documents/:id", requireAuth, requirePermission("workspace.settings.manage"), async (req, res) => {
  try {
    await knowledgeBase.deleteDocument(req.orgId, req.params.id);
    auditLog.record(req.orgId, req, "knowledge.delete_document", "knowledge_document", req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

router.post("/search", requireAuth, async (req, res) => {
  try {
    const { query } = req.body || {};
    res.json(await knowledgeBase.search(req.orgId, query, 5));
  } catch (err) { res.status(err.statusCode || 500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
