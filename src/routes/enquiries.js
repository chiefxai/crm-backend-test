// src/routes/enquiries.js — /api/enquiries

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const db = require("../db/repository");
const { parsePagination } = require("../lib/pagination");

router.get("/", requireAuth, async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const { callId } = req.query;

    if (!pagination) {
      // Either the full unpaginated list, or (used by the call-detail
      // sidebar) just one call's own enquiries — no openCount needed.
      const rows = await db.getEnquiriesWithContacts(req.orgId, { callId });
      return res.json(callId ? { rows } : rows);
    }

    const result = await db.getEnquiriesWithContacts(req.orgId, { ...pagination, callId });

    // The page view's header shows "N still open" across the WHOLE table,
    // not just this page — a cheap count-only query alongside the paged
    // rows keeps that correct without pulling every row over the wire.
    const openCount = await db.supabase
      .from("enquiries")
      .select("id", { count: "exact", head: true })
      .eq("org_id", req.orgId)
      .eq("status", "new")
      .then(({ count, error }) => { if (error) throw error; return count ?? 0; });

    res.json({ ...result, openCount });
  }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const patch = { ...(req.body || {}) };
    // Prefer the canonical contact relationship. If the caller only supplies
    // callId, resolve its lead_id so future reads can JOIN directly to leads.
    if (!patch.leadId && patch.callId) {
      const call = await db.getCallLogById(req.orgId, patch.callId);
      if (call?.leadId) patch.leadId = call.leadId;
    }
    const updated = await db.patch("enquiries", req.orgId, req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "Enquiry not found" });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
