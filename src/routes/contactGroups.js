// src/routes/contactGroups.js — /api/contact-groups
//
// Contact Directory groups. A contact (lead) can belong to zero, one, or
// many groups — group membership lives directly on the lead's own
// group_ids array (see leads.js / db.repository's "leads" entity), not a
// join table here. This route only manages the groups themselves
// (create/rename/delete) — assigning a contact to a group is done by
// PATCHing that lead's groupIds field via the existing /api/leads/:id.

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth, requirePermission } = require("../middleware/auth");
const db = require("../db/repository");

router.get("/", requireAuth, async (req, res) => {
  try { res.json(await db.list("contactgroups", req.orgId)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const group = await db.create("contactgroups", req.orgId, { name });
    res.status(201).json(group);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const updated = await db.patch("contactgroups", req.orgId, req.params.id, { name });
    if (!updated) return res.status(404).json({ error: "Group not found" });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Deleting a group leaves its members in place (just ungrouped) — strip the
// deleted group id out of every lead that referenced it so nothing points
// at a group that no longer exists.
router.delete("/:id", requireAuth, requirePermission("workspace.delete"), async (req, res) => {
  try {
    const groupId = req.params.id;
    const leads = await db.list("leads", req.orgId);
    const affected = leads.filter(l => (l.groupIds || []).includes(groupId));
    await Promise.all(affected.map(l =>
      db.patch("leads", req.orgId, l.id, { groupIds: (l.groupIds || []).filter(g => g !== groupId) })
    ));
    await db.remove("contactgroups", req.orgId, groupId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
