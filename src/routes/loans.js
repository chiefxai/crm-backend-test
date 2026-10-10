// src/routes/loans.js — /api/loans

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const db = require("../db/repository");
const lendingObjectsMirror = require("../crm/lendingObjectsMirror");
const { requireModule } = require("../workspaces/moduleEntitlements");
const requireLoanModule = requireModule('loan_lifecycle');

router.get("/", requireAuth, requireLoanModule, async (req, res) => {
  try { res.json(await db.getLoansWithContacts(req.orgId)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/", requireAuth, requireLoanModule, async (req, res) => {
  try {
    const newLoan = await db.create("loans", req.orgId, req.body);
    global.broadcastLog(`💵 Created loan application: ${newLoan.id}`, { type: "loan", loanId: newLoan.id });
    res.status(201).json(newLoan);
    lendingObjectsMirror.mirrorLoanCreate(req.orgId, newLoan);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/:id", requireAuth, requireLoanModule, async (req, res) => {
  try {
    const updated = await db.patch("loans", req.orgId, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Loan not found" });
    global.broadcastLog(`💵 Updated loan: ${updated.id}`, { type: "loan", loanId: req.params.id });
    res.json(updated);
    lendingObjectsMirror.mirrorLoanPatch(req.orgId, req.params.id, updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/sync", requireAuth, requireLoanModule, async (req, res) => {
  try {
    const result = await db.replaceAll("loans", req.orgId, req.body);
    res.json(result);
    lendingObjectsMirror.mirrorReplaceAll(req.orgId, "loans", result);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
