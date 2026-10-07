// ============================================================
// services/objectsRoutes.js
//
// REST API for the generic objects/fields/records/pipelines engine
// (see objectsEngine.js + schema_part4_generic_objects.sql). Mounted
// at /api/objects in server.js.
// ============================================================

const { safeErrorMessage } = require("../observability/safeError");
const express = require("express");
const engine = require("../crm/objectsEngine");
const auditLog = require("../platform/auditLog");
const { requireAuth, requireRole, ADMIN_ROLES } = require("../middleware/auth");
const { getLogger } = require("../observability/logger");
const { parsePagination } = require("../lib/pagination");
const log = getLogger("routes.objects");

const router = express.Router();

function handleEngineError(err, res) {
  const status = err.statusCode || 500;
  if (status >= 500) log.error("❌ objectsRoutes:", err.message);
  res.status(status).json({ error: safeErrorMessage(err) });
}

// object_records.id is a MySQL uuid column — a malformed :id here (e.g.
// "undefined", empty string) fails at the DB layer with an opaque "could
// not determine data type of parameter $1" rather than a clean 404/400.
// Catching it here keeps a misbehaving caller from generating a wall of
// unhelpful 500s in the logs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireValidRecordId(req, res, next) {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: `Invalid record id "${req.params.id}"` });
  }
  next();
}

router.get("/", requireAuth, async (req, res) => {
  try {
    res.json(await engine.listObjects(req.orgId));
  } catch (err) {
    handleEngineError(err, res);
  }
});

// Defining a new object type is a schema change — admin-level action,
// same bar as org settings/team management.
router.post("/", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const created = await engine.createObject(req.orgId, req.body);
    auditLog.record(req.orgId, req, "object.create", "object", created.id, { key: created.key, label: created.label });
    res.status(201).json(created);
  } catch (err) {
    handleEngineError(err, res);
  }
});

router.get("/:key", requireAuth, async (req, res) => {
  try {
    const object = await engine.getObjectByKey(req.orgId, req.params.key);
    if (!object) return res.status(404).json({ error: `Object "${req.params.key}" not found` });
    res.json(object);
  } catch (err) {
    handleEngineError(err, res);
  }
});

router.get("/:key/records", requireAuth, async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    res.json(await engine.listRecords(req.orgId, req.params.key, pagination || {}));
  } catch (err) {
    handleEngineError(err, res);
  }
});

router.post("/:key/records", requireAuth, async (req, res) => {
  try {
    const record = await engine.createRecord(req.orgId, req.params.key, req.body || {});
    res.status(201).json(record);
  } catch (err) {
    handleEngineError(err, res);
  }
});

router.patch("/:key/records/:id", requireAuth, requireValidRecordId, async (req, res) => {
  try {
    const updated = await engine.patchRecord(req.orgId, req.params.key, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Record not found" });
    res.json(updated);
  } catch (err) {
    handleEngineError(err, res);
  }
});

router.delete("/:key/records/:id", requireAuth, requireValidRecordId, async (req, res) => {
  try {
    const removed = await engine.removeRecord(req.orgId, req.params.key, req.params.id);
    if (!removed) return res.status(404).json({ error: "Record not found" });
    res.json({ success: true });
  } catch (err) {
    handleEngineError(err, res);
  }
});

module.exports = router;
