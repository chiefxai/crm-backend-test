// src/routes/calls.js — /api/calls, /api/call-logs, /api/inbound-call-logs
// Mount this router at /api (not /api/calls) so call-logs paths resolve correctly.

const { safeErrorMessage } = require("../observability/safeError");
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const db = require("../db/repository");
const conversationIntelligence = require("../ai/conversationIntelligence");
const storage = require("../storage");
const { normalizePhone } = require("../lib/phone");
const { parsePagination } = require("../lib/pagination");
const { getLogger } = require("../observability/logger");
const log = getLogger("routes.calls");

// ── Supabase calls table (transcripts + recordings) ──
// Inserted by the voice pipeline on call end; org_id not yet tagged there,
// so these return empty for all orgs — safe but incomplete until wired up.
router.get("/calls", requireAuth, async (req, res) => {
  if (!db.supabase) return res.json([]);
  try {
    const { data, error } = await db.supabase
      .from("calls")
      .select("id, caller_number, agent_name, language, duration_seconds, sentiment, recording_url, created_at, transcript")
      .eq("org_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    log.error("❌ /api/calls error:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get("/calls/:id/transcript", requireAuth, async (req, res) => {
  if (!db.supabase) return res.json({ transcript: "" });
  try {
    const { data, error } = await db.supabase
      .from("calls")
      .select("id, caller_number, agent_name, duration_seconds, sentiment, recording_url, created_at, transcript")
      .eq("id", req.params.id).eq("org_id", req.orgId).maybeSingle();
    if (error) throw error;
    res.json(data || {});
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Recursively collects a QuestionFlow's top-level variables plus every
// branch's conditional follow-up variables (a follow-up can itself branch
// further) — same flattening DialerSimulator.tsx's handleCreateTask does
// when building a task's question list, kept in sync here so a lookup by
// question text finds branch-only variables too.
function flattenWorkflowVariables(variables) {
  const out = [];
  for (const v of variables || []) {
    out.push(v);
    for (const branch of v.branches || []) {
      out.push(...flattenWorkflowVariables(branch.variables));
    }
  }
  return out;
}

router.get("/calls/:id/lead-responses", requireAuth, async (req, res) => {
  if (!db.supabase) return res.json([]);
  try {
    const { data, error } = await db.supabase
      .from("lead_responses")
      .select("question, answer, label, created_at")
      .eq("call_id", req.params.id).eq("org_id", req.orgId)
      .order("created_at", { ascending: true });
    if (error) throw error;

    // The stored `label` can be stale or plain wrong for a row saved
    // before its workflow variable had a real name filled in (the field
    // is optional in Workflow Builder) — that row's label ends up either
    // the raw question text, or a slugified version of it, baked in
    // forever at the time the answer was captured. Rather than trust that
    // snapshot, re-resolve each row's real name + data type from the
    // workflow's CURRENT variable definitions (a workflow only ever gets
    // edited, never has its variables' meaning change independent of
    // question text) — matched by question text, which is stable.
    //
    // Resolve the workflow ourselves instead of trusting a frontend-
    // supplied ?workflowId= (still accepted for compat/inbound cases where
    // there's no dialer task to look up): find the dialer task whose
    // callResults actually produced this call, and read ITS workflowId —
    // this is the one truly authoritative source and works regardless of
    // which task happens to be "selected" in the caller's UI state, or
    // whether the frontend's local task even has workflowId loaded at all.
    let workflowId = req.query.workflowId || null;
    if (!workflowId) {
      try {
        const tasks = await db.list("dialertasks", req.orgId);
        const owningTask = (tasks || []).find((t) =>
          Object.values(t.callResults || {}).some((r) => r.callId === req.params.id)
        );
        workflowId = owningTask?.workflowId || null;
      } catch (_) { /* fall through to stored label below */ }
    }

    let byQuestion = new Map();
    if (workflowId) {
      try {
        const flows = await db.list("questionflows", req.orgId);
        const flow = (flows || []).find((f) => f.id === workflowId);
        if (flow) {
          byQuestion = new Map(
            flattenWorkflowVariables(flow.variables).map((v) => [v.questionText, v])
          );
        }
      } catch (_) { /* fall through to stored label below */ }
    }

    res.json((data || []).map((row) => {
      const variable = byQuestion.get(row.question);
      return {
        ...row,
        label: variable?.name?.trim() || row.label || row.question,
        dataType: variable?.dataType || null,
      };
    }));
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Generate AI summary/sentiment/next-action from a stored transcript.
router.post("/calls/:id/analyze", requireAuth, async (req, res) => {
  try {
    const result = await conversationIntelligence.analyzeCall(req.orgId, req.params.id);
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) log.error("❌ /api/calls/:id/analyze:", err.message);
    res.status(status).json({ error: safeErrorMessage(err) });
  }
});

// ── Call logs (org CRM table) ──
router.get("/call-logs", requireAuth, async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const result = await db.getCallLogsWithContacts(req.orgId, pagination || {});
    const logs = pagination ? result.rows : result;
    const enriched = logs;
    // Turns a bare object key (STORAGE_USE_SIGNED_URLS=true) into a fresh
    // playable link; a no-op passthrough for a row that already holds a
    // real URL (default public-bucket mode, or any pre-existing row) —
    // see storage/index.js's resolvePlaybackUrl.
    const withPlaybackUrls = await Promise.all(
      enriched.map(async (log) => ({ ...log, recordingUrl: await storage.resolvePlaybackUrl(log.recordingUrl) }))
    );
    res.json(pagination ? { rows: withPlaybackUrls, total: result.total } : withPlaybackUrls);
  }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/call-logs", requireAuth, async (req, res) => {
  try {
    const newLog = await db.create("calllogs", req.orgId, req.body);
    global.broadcastLog(`📞 Logged call with: ${newLog.leadName || "Contact"}`, { type: "calllog", logId: newLog.id });
    res.status(201).json(newLog);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/call-logs/sync", requireAuth, async (req, res) => {
  try { res.json(await db.replaceAll("calllogs", req.orgId, req.body)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Inbound call logs (dialer simulator tab) ──
router.get("/inbound-call-logs", requireAuth, async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    res.json(await db.list("inboundcalllogs", req.orgId, pagination || {}));
  }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/inbound-call-logs/sync", requireAuth, async (req, res) => {
  try { res.json(await db.replaceAll("inboundcalllogs", req.orgId, req.body)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Scheduled callbacks (Campaign > Scheduled tab) ──
// Every call still pending an automatic redial for this org — a caller
// who explicitly asked for a callback ("Callback Scheduled") AND one
// nobody picked up for ("No Answer"/"Answering Machine") — who, their
// phone, when the redial will happen, why, and (for outbound campaign
// calls) which workflow it came from. Inbound calls have no workflow —
// see db.getScheduledCallbacks.
router.get("/scheduled-callbacks", requireAuth, async (req, res) => {
  try { res.json(await db.getScheduledCallbacks(req.orgId)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
