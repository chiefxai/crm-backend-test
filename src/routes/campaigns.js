// src/routes/campaigns.js — /api/campaigns, /api/workflows, /api/dialer-*

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const db = require("../db/repository");
const workflowEngine = require("../crm/workflowEngine");
const storage = require("../storage");
const { parsePagination } = require("../lib/pagination");
const { getLogger } = require("../observability/logger");
const log = getLogger("routes.campaigns");

// ── Campaigns ──
router.get("/campaigns", requireAuth, async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const result = await db.list("campaigns", req.orgId, pagination || {});
    const rows = Array.isArray(result) ? result : result.rows;
    const normalized = rows.map((campaign) => ({
      ...campaign,
      retryConfig: db.normalizeRetryPolicy(campaign.retryConfig || db.DEFAULT_RETRY_POLICY),
    }));
    res.json(Array.isArray(result) ? normalized : { ...result, rows: normalized });
  }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/campaigns", requireAuth, async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (body.retryConfig !== undefined) {
      body.retryConfig = db.normalizeRetryPolicy(body.retryConfig || {});
    } else {
      body.retryConfig = db.DEFAULT_RETRY_POLICY;
    }
    const c = await db.create("campaigns", req.orgId, body);
    global.broadcastLog(`📢 Created campaign: ${c.name}`, { type: "campaign", campaignId: c.id });
    res.status(201).json({ ...c, retryConfig: db.normalizeRetryPolicy(c.retryConfig || db.DEFAULT_RETRY_POLICY) });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/campaigns/:id", requireAuth, async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (body.retryConfig !== undefined) {
      body.retryConfig = db.normalizeRetryPolicy(body.retryConfig || {});
    }
    const updated = await db.patch("campaigns", req.orgId, req.params.id, body);
    if (!updated) return res.status(404).json({ error: "Campaign not found" });
    global.broadcastLog(`📢 Updated campaign: ${updated.name}`, { type: "campaign", campaignId: req.params.id });
    res.json({ ...updated, retryConfig: db.normalizeRetryPolicy(updated.retryConfig || db.DEFAULT_RETRY_POLICY) });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/campaigns/sync", requireAuth, async (req, res) => {
  try { res.json(await db.replaceAll("campaigns", req.orgId, req.body)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Workflows ──
router.get("/workflows", requireAuth, async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    res.json(await db.list("workflows", req.orgId, pagination || {}));
  }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/workflows", requireAuth, async (req, res) => {
  try {
    const w = await db.create("workflows", req.orgId, req.body);
    global.broadcastLog(`⚙️ Created workflow: ${w.name}`, { type: "workflow", workflowId: w.id });
    res.status(201).json(w);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/workflows/:id", requireAuth, async (req, res) => {
  try {
    const updated = await db.patch("workflows", req.orgId, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Workflow not found" });
    global.broadcastLog(`⚙️ Updated workflow: ${updated.name}`, { type: "workflow", workflowId: req.params.id });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/workflows/:id/run", requireAuth, async (req, res) => {
  try {
    const { leadId } = req.body || {};
    if (!leadId) return res.status(400).json({ error: "leadId is required" });
    const run = await workflowEngine.runWorkflow(req.orgId, req.params.id, leadId);
    global.broadcastLog(`⚙️ Workflow run: ${run.status}`, { type: "workflow", workflowId: req.params.id, leadId });
    res.status(201).json(run);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) log.error("❌ /api/workflows/:id/run:", err.message);
    res.status(status).json({ error: safeErrorMessage(err) });
  }
});

router.get("/workflows/:id/runs", requireAuth, async (req, res) => {
  try { res.json(await workflowEngine.listRuns(req.orgId, req.params.id)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/workflows/sync", requireAuth, async (req, res) => {
  try { res.json(await db.replaceAll("workflows", req.orgId, req.body)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Dialer tasks + retries ──
router.get("/dialer-tasks", requireAuth, async (req, res) => {
  try {
    const rows = await db.list("dialertasks", req.orgId);
    // Each task's callResults[leadId].recordingUrl is a bare object key in
    // STORAGE_USE_SIGNED_URLS mode (see storage/index.js) — resolve every
    // one to a fresh playable link, in parallel across the whole page of
    // tasks. A no-op passthrough for a row that already holds a real URL
    // (default public-bucket mode), so this is safe either way.
    const resolved = await Promise.all(rows.map(async (task) => {
      const callResults = task.callResults;
      if (!callResults || typeof callResults !== "object") return task;
      const entries = await Promise.all(
        Object.entries(callResults).map(async ([leadId, result]) => [
          leadId,
          result?.recordingUrl ? { ...result, recordingUrl: await storage.resolvePlaybackUrl(result.recordingUrl) } : result,
        ])
      );
      return { ...task, callResults: Object.fromEntries(entries) };
    }));
    res.json(resolved.map((task) => ({
      ...task,
      retryConfig: db.normalizeRetryPolicy(task.retryConfig || db.DEFAULT_RETRY_POLICY),
    })));
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/dialer-tasks/sync", requireAuth, async (req, res) => {
  try {
    // The browser periodically syncs its local task list, but server-side
    // auto-dial runtime state is authoritative. Never let a stale React/
    // localStorage snapshot turn auto-dial back on after the user pressed Stop.
    const incoming = Array.isArray(req.body) ? req.body : [];
    const existing = await db.list("dialertasks", req.orgId);
    const byId = new Map(existing.map((task) => [task.id, task]));
    const runtimeFields = [
      "autoDialEnabled", "autoDialStatus", "autoDialStartedAt", "nextDialAt",
      "currentLeadId", "currentProviderCallSid", "currentProvider", "currentCallStartedAt", "autoDialRunId",
    ];
    const merged = incoming.map((task) => {
      const current = byId.get(task.id);
      const copy = { ...task };
      copy.retryConfig = db.normalizeRetryPolicy(
        task.retryConfig || current?.retryConfig || db.DEFAULT_RETRY_POLICY
      );
      if (current) {
        for (const field of runtimeFields) {
          if (Object.prototype.hasOwnProperty.call(current, field)) copy[field] = current[field];
        }
      }
      return copy;
    });
    res.json(await db.replaceAll("dialertasks", req.orgId, merged));
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Per-task update — added alongside /sync so a single field (e.g. the
// auto-dial toggle below) can change without pushing the frontend's whole
// local task list through the delete+reinsert /sync path.
router.patch("/dialer-tasks/:id", requireAuth, async (req, res) => {
  try {
    const updated = await db.patch("dialertasks", req.orgId, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Dialer task not found" });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Single-task create — added so a newly created task can be pushed to the
// backend and started immediately (auto-dial is now the default the
// moment a task is created — see DialerSimulator.tsx's handleCreateTask),
// instead of waiting on the debounced /sync (which can take up to 800ms
// and would otherwise race against an immediate auto-dial/start call for
// a task the backend doesn't know about yet).
router.post("/dialer-tasks", requireAuth, async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    body.retryConfig = db.normalizeRetryPolicy(body.retryConfig || db.DEFAULT_RETRY_POLICY);

    // A workflow is a reusable definition, while each dialer task is one
    // concrete execution of that workflow. Store immutable run metadata so
    // two campaigns created from the same workflow can always be
    // distinguished without changing the workflow name.
    if (body.workflowId && !body.workflowRunMetadata) {
      const workflows = await db.list("workflows", req.orgId);
      const workflow = workflows.find((w) => w.id === body.workflowId);
      const runAt = body.createdAt || new Date().toISOString();
      body.workflowRunMetadata = {
        workflowId: body.workflowId,
        workflowName: workflow?.name || body.workflowName || null,
        runAt,
        runDate: runAt.slice(0, 10),
        runTime: runAt.slice(11, 19),
        timezone: "UTC"
      };
    }

    const created = await db.create("dialertasks", req.orgId, body);
    res.status(201).json({ ...created, retryConfig: body.retryConfig });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Starts/resumes server-side auto-dial for this task — see
// src/crm/autoDialEngine.js, which owns actually placing the calls on its
// own polling loop from here on. This keeps working even if the browser
// that clicked "Auto-Dial" is closed a moment later. Accepts an optional
// { outboundNumber } — the number selected in the Voice Simulator at the
// moment auto-dial was (re)started, since the engine has no per-request
// "selected number" to read once the frontend is gone.
router.post("/dialer-tasks/:id/auto-dial/start", requireAuth, async (req, res) => {
  try {
    const tasks = await db.list("dialertasks", req.orgId);
    const task = tasks.find((t) => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: "Dialer task not found" });

    const hasPending = (task.leadIds || []).some((leadId) => {
      const r = task.callResults && task.callResults[leadId];
      return !r || r.status === "Pending" || r.status === "Callback Scheduled";
    });
    if (!hasPending) return res.status(400).json({ error: "Every lead in this task has already been dialed." });

    const patch = {
      autoDialEnabled: true,
      autoDialStatus: "waiting",
      autoDialStartedAt: new Date().toISOString(),
      autoDialRunId: require("crypto").randomUUID(),
      nextDialAt: new Date().toISOString(), // dial immediately on the next poll tick
    };
    if (req.body && req.body.outboundNumber) patch.outboundNumber = req.body.outboundNumber;

    const updated = await db.patch("dialertasks", req.orgId, req.params.id, patch);
    log.info(`🤖 Auto-dial started for task "${task.name}" (org ${req.orgId})`);

    // Do not wait for the scheduler's next 15-second tick for the first call.
    // The scheduler remains responsible for the continuous campaign loop, but
    // the explicit Start Campaign action should immediately hand the task to
    // the same auto-dial engine. This also makes the first dial resilient to
    // a scheduler container being briefly unavailable during a deployment.
    setImmediate(() => {
      const { processAutoDialTasks } = require("../crm/autoDialEngine");
      processAutoDialTasks().catch((err) => {
        log.error(`❌ Immediate auto-dial dispatch failed for task ${req.params.id}:`, err.message);
      });
    });

    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Campaign task deletion ────────────────────────────────────────────────
// Deletion is deliberately restricted to the customer Organization Admin.
// The endpoint never cascades silently: the caller must explicitly choose
// which related CRM data should also be removed/reset.
const requireOrganizationAdmin = requireRole(["Organization Admin"]);

router.get("/dialer-tasks/:id/delete-impact", requireAuth, requireOrganizationAdmin, async (req, res) => {
  try {
    const impact = await db.getDialerTaskDeletionImpact(req.orgId, req.params.id);
    if (!impact) return res.status(404).json({ error: "Dialer task not found" });
    res.json(impact);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.delete("/dialer-tasks/:id", requireAuth, requireOrganizationAdmin, async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: "Deletion confirmation is required" });
    }

    const result = await db.deleteDialerTaskData(req.orgId, req.params.id, {
      deleteLeads: req.body?.deleteLeads === true,
      deleteEnquiries: req.body?.deleteEnquiries === true,
      deleteScheduledCallbacks: req.body?.deleteScheduledCallbacks === true,
      removeFromPipeline: req.body?.removeFromPipeline === true,
    }, {
      userId: req.userId,
      userEmail: req.userEmail,
    });

    global.broadcastLog(\`🗑️ Deleted campaign task: \${result.taskName}\`, {
      type: "campaign-task-deleted",
      taskId: result.taskId,
      orgId: req.orgId,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    const status = Number(err.statusCode) || 500;
    if (status >= 500) log.error("❌ /api/dialer-tasks/:id DELETE:", err.message);
    res.status(status).json({ error: safeErrorMessage(err) });
  }
});

// Stops the server-side loop from placing any further calls for this
// task, AND immediately hangs up whatever call is currently in flight for
// it — a full stop, not just "don't dial the next one". The call's
// outcome still gets logged normally (hanging up produces the same
// call_logs row a natural hangup would), so autoDialEngine's next poll
// tick still records it against the lead that was mid-call.
router.post("/dialer-tasks/:id/auto-dial/stop", requireAuth, async (req, res) => {
  try {
    const tasks = await db.list("dialertasks", req.orgId);
    const task = tasks.find((t) => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: "Dialer task not found" });

    const updated = await db.patch("dialertasks", req.orgId, req.params.id, {
      autoDialEnabled: false,
      autoDialStatus: "paused",
      autoDialRunId: null,
    });

    if (task.currentProviderCallSid) {
      const { forceHangupCurrentCall } = require("../crm/autoDialEngine");
      forceHangupCurrentCall({ ...task, orgId: req.orgId })
        .catch((err) => log.error(`❌ Failed to force-hang-up call for task ${req.params.id}:`, err.message));
    }

    log.info(`🤖 Auto-dial stopped for task ${req.params.id} (org ${req.orgId})`);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.get("/dialer-retries", requireAuth, async (req, res) => {
  try { res.json(await db.getRetryStatusForOrg(req.orgId)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Question flows (workflow builder) ────────────────────────────────────────
router.get("/question-flows", requireAuth, async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    res.json(await db.list("questionflows", req.orgId, pagination || {}));
  }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/question-flows", requireAuth, async (req, res) => {
  try { res.status(201).json(await db.create("questionflows", req.orgId, req.body)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/question-flows/:id", requireAuth, async (req, res) => {
  try {
    const updated = await db.patch("questionflows", req.orgId, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Question flow not found" });
    res.json(updated);
  }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.delete("/question-flows/:id", requireAuth, async (req, res) => {
  try {
    await db.remove("questionflows", req.orgId, req.params.id);
    res.json({ ok: true });
  }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/question-flows/sync", requireAuth, async (req, res) => {
  try { res.json(await db.replaceAll("questionflows", req.orgId, req.body)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
