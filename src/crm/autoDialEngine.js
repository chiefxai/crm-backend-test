// src/crm/autoDialEngine.js
// ============================================================
// Server-side "Continuous Dialer Mode" — walks a dialer task's lead list
// and places one outbound call at a time, entirely on the backend. This
// used to live only in the frontend (DialerSimulator.tsx): a React effect
// watched each call finish, waited 3s, then dialed the next lead. That
// meant closing the browser tab — or the laptop going to sleep, or the
// user just navigating away — silently stopped the campaign mid-list with
// no error, no notification, and no way to resume other than reopening
// the exact page and turning it back on.
//
// This engine polls dialer_tasks the same way services/dialerRetryEngine.js
// polls call_logs for due retries: state lives entirely in MySQL, the
// interval just re-reads it, so a server restart loses at most one poll
// tick's worth of progress, never the campaign itself. The frontend now
// only ever calls POST /api/dialer-tasks/:id/auto-dial/start|stop (see
// src/routes/campaigns.js) to flip auto_dial_enabled — it no longer
// drives the loop itself.
// ============================================================

const db = require("../db/repository");
const { getQueue } = require("../queue");
const { getLogger } = require("../observability/logger");
const log = getLogger("crm.autoDialEngine");
const telephony = require("../telephony/registry");

const INTER_CALL_DELAY_MS = 3 * 1000; // matches the frontend's prior pacing between one call ending and the next starting
const STUCK_CALL_MAX_AGE_MS = 30 * 60 * 1000; // same bound as the 30-min Map TTLs triggerVobizOutboundCall itself uses
// Actually PLACING a call — the outbound HTTP request to Vobiz that
// starts ringing the lead's phone — now runs through the same job-queue
// infrastructure the post-call pipeline already uses (see
// vobizProxy.js's postCallQueue), instead of
// happening inline inside a poll tick. Bounded concurrency means several
// tasks/orgs can have calls placed in parallel instead of every dial
// across the whole platform being serialized behind one 15s poll loop;
// each job still makes exactly one placement attempt and never rethrows
// (see handlePlaceDialJob below) — business-level retry for a failed
// placement stays with dialerRetryEngine.js's own later redial, same as
// before this change.
const DIAL_CONCURRENCY = 5;

function getPublicBaseUrl() {
  // A background job has no incoming HTTP request to build a callback URL
  // from the way /api/vobiz/call does (req.headers.host) — PUBLIC_URL was
  // the only thing that ever worked for services/dialerRetryEngine.js's
  // identical need, but it's an env var most deployments never had a
  // reason to set (confirmed in production: this engine paused every task
  // immediately with "No PUBLIC_URL configured" on a VM that had never
  // needed it before). DOMAIN, by contrast, is required for Caddy's own
  // automatic-HTTPS setup (see Caddyfile/Caddyfile.uat's `{$DOMAIN}`) —
  // any deployment serving HTTPS at all already has it set, so fall back
  // to it before giving up.
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  if (process.env.DOMAIN) return `https://${process.env.DOMAIN}`;
  return null;
}

// Maps a finished call_logs row's status onto the status enum the
// frontend's DialTaskCallResult type already expects (ReportsView.tsx /
// PrintableReport.tsx) — 'Pending' | 'Calling' | 'Completed' | 'No Answer' | 'Skipped'.
// Anything that isn't a clean "Completed" or "No Answer" (a hard API
// error, missing credentials, etc) is folded into "No Answer" rather than
// a status the frontend type doesn't know about, so old UI code doesn't
// have to change to render it.
function mapCallStatusToResultStatus(status) {
  if (status === "Completed") return "Completed";
  if (status === "No Answer") return "No Answer";
  // "Callback Scheduled" (caller said they're busy, asked to be called
  // back — see callFinalizer.js/postCallAgents.js:extractFollowUp) must
  // pass through as its own status, not collapse into "No Answer": a
  // lead the AI actually reached and is deliberately holding for a
  // scheduled retry (dialerRetryEngine.js) is a different situation from
  // one nobody picked up for.
  if (status === "Callback Scheduled") return "Callback Scheduled";
  return "No Answer";
}

// Matches a raw outbound number string to its provider — used only as a
// fallback (see resolveProviderAndAgent below) for a task that was
// started without ever picking an agent with its own assigned number.
async function resolveProviderFromNumberString(orgId, outboundNumber) {
  if (!outboundNumber) return { provider: telephony.getDefaultProvider(), from: undefined };
  let numbers = [];
  try {
    numbers = await db.list("numbers", orgId);
  } catch (err) {
    log.error(`❌ [autoDialEngine] Failed to look up numbers for org ${orgId}:`, err.message);
    return { provider: telephony.getDefaultProvider(), from: outboundNumber };
  }
  const match = numbers.find((n) => n.number === outboundNumber);
  const providerName = (match?.provider || "").toLowerCase();
  const connector = telephony.findConnector(providerName); return { provider: connector?.name || providerName || telephony.getDefaultProvider(), from: outboundNumber };
  return { provider: providerName || "unknown", from: outboundNumber };
}

// Resolves provider + from-number + agentId for a task's next dial.
//
// The dialer-task wizard's "agent" picker (DialerSimulator.tsx's
// wizardAgentId) is stored on the task under `assignedTeamMemberId` — a
// pre-existing naming quirk in this codebase, not something this engine
// introduced: the frontend's OWN manual-dial code already does the exact
// same thing (`agentId: selectedTask?.assignedTeamMemberId`) when placing
// a call itself. Kept identical here so a task behaves the same whether
// a human clicks "Dial" or the background engine does.
//
// Each AI agent (org_agents table) carries its own outboundNumberId — a
// specific virtual_numbers row assigned via Settings > Agents — which is
// the actual source of truth for which number/provider a wizard-selected
// agent should dial through. Resolving through the agent (rather than
// only the task-level outboundNumber string set at auto-dial-start time)
// means: (a) the right AI voice/persona actually gets used — passing
// agentId through to triggerVobizOutboundCall
// is what makes that call show up in logs as "using wizard-selected
// agent", not silently fall back to a generic default persona; (b) the
// right provider gets picked without depending on the frontend having
// had some particular number selected in an unrelated part of the UI at
// the exact moment "Run in Background" was clicked.
async function resolveProviderAndAgent(orgId, task) {
  const agentId = task.assignedTeamMemberId || null;
  if (agentId) {
    try {
      const agent = await db.getAgent(agentId, orgId);
      if (agent && agent.outboundNumberId) {
        const numbers = await db.list("numbers", orgId);
        const numRow = numbers.find((n) => n.id === agent.outboundNumberId);
        if (numRow) {
          const providerName = (numRow.provider || "").toLowerCase();
          const connector = telephony.findConnector(providerName); const provider = connector?.name || providerName || telephony.getDefaultProvider();
          return { provider, from: numRow.number, agentId };
        }
      }
    } catch (err) {
      log.error(`❌ [autoDialEngine] Failed to resolve agent ${agentId} for org ${orgId}:`, err.message);
    }
  }
  // No agent, or the agent has no outbound number assigned yet — fall
  // back to the raw number string captured when auto-dial was started.
  const fallback = await resolveProviderFromNumberString(orgId, task.outboundNumber);
  return { ...fallback, agentId };
}

function nextPendingLeadId(task) {
  const results = task.callResults || {};
  return (task.leadIds || []).find((leadId) => {
    const r = results[leadId];
    return !r || r.status === "Pending";
  }) || null;
}

// One task, one tick. Never throws — every branch either advances the
// task's own state or leaves it untouched for the next tick to retry.
function isInsufficientRechargeBalanceError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || err || "").toLowerCase();
  return (
    code === "INSUFFICIENT_RECHARGE_BALANCE" ||
    err?.isRechargeBillingError === true ||
    Number(err?.statusCode) === 402 ||
    /insufficient recharge balance|recharge balance is empty/.test(message)
  );
}

async function processTask(task) {
  const { orgId, id: taskId } = task;

  // A wallet block is terminal for this auto-dial run. Repair stale task
  // snapshots as well as newly written state so a scheduler tick cannot
  // immediately claim the same lead again after an insufficient-balance
  // failure.
  if (task.autoDialBlockedReason === "insufficient_balance") {
    if (task.autoDialEnabled || task.autoDialStatus !== "paused" || task.currentLeadId || task.currentProviderCallSid) {
      await db.patch("dialertasks", orgId, taskId, {
        currentLeadId: null,
        currentProviderCallSid: null,
        currentCallStartedAt: null,
        autoDialEnabled: false,
        autoDialStatus: "paused",
        autoDialBlockedReason: "insufficient_balance",
        nextDialAt: null,
        autoDialRunId: null,
      }).catch((patchErr) => {
        log.error(`❌ [autoDialEngine] Failed to persist insufficient-balance pause for task ${taskId} (org ${orgId}):`, patchErr.message);
      });
    }
    return;
  }

  // ── A call is already in flight for this task — check if it finished ──
  if (task.currentProviderCallSid) {
    let finishedLog = null;
    try {
      finishedLog = await db.findCallLogByProviderCallSid(orgId, task.currentProviderCallSid);
    } catch (err) {
      log.error(`❌ [autoDialEngine] Lookup failed for task ${taskId} (org ${orgId}):`, err.message);
      return;
    }

    if (finishedLog) {
      const leadId = task.currentLeadId;
      const callResults = { ...(task.callResults || {}) };
      if (leadId) {
        callResults[leadId] = {
          status: mapCallStatusToResultStatus(finishedLog.status),
          duration: finishedLog.duration || 0,
          sentiment: finishedLog.sentiment || "Unknown",
          intent: "Unknown",
          summary: finishedLog.summary || "",
          recordingUrl: finishedLog.recordingUrl || undefined,
          callId: finishedLog.id,
          callbackTime: finishedLog.callbackTime || undefined,
          callAnswered: finishedLog.callAnswered,
          conversationOutcome: finishedLog.conversationOutcome,
          callbackStatus: finishedLog.callbackStatus,
          enquiryStatus: finishedLog.enquiryStatus,
          callbackReason: finishedLog.callbackReason,
        };
      }
      // Auto-dial is a single-call execution mode: once the current
      // call finishes, stop dialing automatically. The user must explicitly
      // start Auto Dial again to place another call. Previously this branch
      // changed the task back to "waiting" while leaving autoDialEnabled=true,
      // which caused the next scheduler tick to dial another lead and made
      // users manually stop the campaign.
      const remainingPending = (task.leadIds || []).some((id) => {
        const result = callResults[id];
        return !result || result.status === "Pending";
      });
      const waitingForCallbacks = !remainingPending && (task.leadIds || []).some((id) => {
        const result = callResults[id];
        return result && result.status === "Callback Scheduled";
      });
      const taskFinished = !remainingPending && !waitingForCallbacks;

      await db.patch("dialertasks", orgId, taskId, {
        callResults,
        currentLeadId: null,
        currentProviderCallSid: null,
        currentCallStartedAt: null,
        autoDialEnabled: false,
        autoDialStatus: taskFinished ? "completed" : (waitingForCallbacks ? "waiting_for_callbacks" : "paused"),
        nextDialAt: null,
      });
      if (global.broadcastLog) {
        global.broadcastLog(`🤖 Auto-dial: finished call to lead ${leadId || "(unknown)"} for task "${task.name}" — ${finishedLog.status}`, {
          type: "auto_dial_progress", orgId, taskId, leadId, status: "call_finished", callStatus: finishedLog.status,
        });
      }
      return;
    }

    // Still ringing/connected — unless it's been in flight implausibly
    // long, in which case the call_logs row it was waiting for likely
    // never got written (a crashed webhook, a WS that never registered a
    // finalizer AND never hit the routes/vobiz.js fallback either). Don't
    // leave the task stuck forever waiting on a call that will never
    // resolve.
    const startedAt = task.currentCallStartedAt ? new Date(task.currentCallStartedAt).getTime() : 0;
    if (startedAt && Date.now() - startedAt > STUCK_CALL_MAX_AGE_MS) {
      log.warn(`⚠️ [autoDialEngine] Task ${taskId} (org ${orgId}) — call to ${task.currentProviderCallSid} never resolved after ${STUCK_CALL_MAX_AGE_MS / 60000}min, treating as failed.`);
      const leadId = task.currentLeadId;
      const callResults = { ...(task.callResults || {}) };
      if (leadId) callResults[leadId] = { status: "No Answer", duration: 0, sentiment: "Unknown", intent: "Unknown", summary: "" };
      await db.patch("dialertasks", orgId, taskId, {
        callResults, currentLeadId: null, currentProviderCallSid: null, currentCallStartedAt: null,
        autoDialStatus: task.autoDialEnabled ? "waiting" : "paused",
        nextDialAt: new Date(Date.now() + INTER_CALL_DELAY_MS).toISOString(),
      });
    }
    return;
  }

  // ── A lead has been claimed and its placement job queued, but the queue
  // hasn't actually placed the call yet (no providerCallSid back from the
  // job handler so far) — wait for it rather than claiming the same lead
  // again next tick. Unstuck by the same staleness bound as an in-flight
  // call above, in case the queue job died without ever calling back. ──
  if (task.currentLeadId) {
    const claimedAt = task.currentCallStartedAt ? new Date(task.currentCallStartedAt).getTime() : 0;
    if (claimedAt && Date.now() - claimedAt > STUCK_CALL_MAX_AGE_MS) {
      log.warn(`⚠️ [autoDialEngine] Task ${taskId} (org ${orgId}) — dial job for lead ${task.currentLeadId} never placed a call after ${STUCK_CALL_MAX_AGE_MS / 60000}min, treating as failed.`);
      const callResults = { ...(task.callResults || {}), [task.currentLeadId]: { status: "No Answer", duration: 0, sentiment: "Unknown", intent: "Unknown", summary: "Dial job never placed the call." } };
      await db.patch("dialertasks", orgId, taskId, {
        callResults, currentLeadId: null, currentCallStartedAt: null,
        autoDialStatus: task.autoDialEnabled ? "waiting" : "paused",
        nextDialAt: new Date(Date.now() + INTER_CALL_DELAY_MS).toISOString(),
      });
    }
    return;
  }

  // ── No call in flight — this task was only kept in scope by a call that
  // just finished above; nothing left to do this tick if auto-dial isn't
  // (or is no longer) enabled ──
  if (!task.autoDialEnabled) return;

  if (task.nextDialAt && new Date(task.nextDialAt).getTime() > Date.now()) return; // still in the inter-call pause

  const pendingLeadId = nextPendingLeadId(task);
  if (!pendingLeadId) {
    const results = task.callResults || {};
    const hasPendingCallbacks = (task.leadIds || []).some((leadId) => {
      const r = results[leadId];
      return r && r.status === "Callback Scheduled";
    });

    if (hasPendingCallbacks) {
      if (task.autoDialStatus !== "waiting_for_callbacks") {
        await db.patch("dialertasks", orgId, taskId, {
          autoDialStatus: "waiting_for_callbacks",
          nextDialAt: new Date(Date.now() + 60000).toISOString(),
        });
        if (global.broadcastLog) {
          global.broadcastLog(`🤖 Auto-dial task "${task.name}" waiting for scheduled callbacks.`, {
            type: "auto_dial_progress", orgId, taskId, status: "waiting_for_callbacks",
          });
        }
      }
      return;
    }

    await db.patch("dialertasks", orgId, taskId, { autoDialEnabled: false, autoDialStatus: "completed" });
    if (global.broadcastLog) {
      global.broadcastLog(`🤖 Auto-dial task "${task.name}" completed — every lead has been dialed.`, {
        type: "auto_dial_progress", orgId, taskId, status: "task_completed",
      });
    }
    return;
  }

  // Atomically claim the lead in MySQL. The old read-then-patch sequence
  // allowed two scheduler instances to claim the same lead during a rolling
  // deploy. Only the instance that receives the returned row may enqueue it.
  const claimedTask = await db.claimAutoDialLead(orgId, taskId, pendingLeadId);
  if (!claimedTask) return;

  try {
    const lead = await db.getLeadById(orgId, pendingLeadId);
    if (!lead || !lead.phone) {
      const callResults = { ...(task.callResults || {}), [pendingLeadId]: { status: "No Answer", duration: 0, sentiment: "Unknown", intent: "Unknown", summary: "Lead not found or missing a phone number." } };
      await db.patch("dialertasks", orgId, taskId, {
        callResults, currentLeadId: null, currentCallStartedAt: null,
        autoDialStatus: "waiting", nextDialAt: new Date(Date.now() + INTER_CALL_DELAY_MS).toISOString(),
      });
      return;
    }

    const baseUrl = getPublicBaseUrl();
    if (!baseUrl) {
      log.error(`❌ [autoDialEngine] No PUBLIC_URL configured — pausing task ${taskId} (org ${orgId}); cannot build outbound-call callback URLs.`);
      await db.patch("dialertasks", orgId, taskId, {
        currentLeadId: null, currentCallStartedAt: null,
        autoDialEnabled: false, autoDialStatus: "paused",
      });
      return;
    }

    const { provider, from, agentId } = await resolveProviderAndAgent(orgId, task);

    if (!telephony.supportsOutbound(provider)) {
      log.error(`❌ [autoDialEngine] Task ${taskId} (org ${orgId}) — outbound number's provider ("${provider}") has no server-side dial support yet; pausing.`);
      await db.patch("dialertasks", orgId, taskId, {
        currentLeadId: null, currentCallStartedAt: null,
        autoDialEnabled: false, autoDialStatus: "paused",
      });
      if (global.broadcastLog) {
        global.broadcastLog(`🤖 Auto-dial task "${task.name}" paused — its outbound number's provider isn't supported for background dialing yet.`, {
          type: "auto_dial_progress", orgId, taskId, status: "paused",
        });
      }
      return;
    }

    // The lead is claimed and everything needed to place the call has
    // been resolved — hand the actual placement (the outbound HTTP
    // request to the telephony provider) to the queue instead of doing it
    // inline here, so a slow/rate-limited provider response doesn't hold
    // up this poll tick from moving on to other tasks. queue.enqueue()
    // returns as soon as the job is accepted, not once it's placed.
    getDialQueue().enqueue("placeDial", {
      orgId, taskId, leadId: pendingLeadId, leadName: lead.name || null, leadPhone: lead.phone,
      taskName: task.name, provider, baseUrl, questions: task.questions, language: task.language,
      from, agentId, starhealthEnabled: !!task.starhealthEnabled,
      retryPolicy: task.retryConfig || task.retryPolicy || task.callResults?.__retryConfig || null,
      autoDialRunId: task.autoDialRunId || null,
    });
  } catch (err) {
    log.error(`❌ [autoDialEngine] Failed to prepare dial for lead ${pendingLeadId} on task ${taskId} (org ${orgId}):`, err.message);
    const callResults = { ...(task.callResults || {}), [pendingLeadId]: { status: "No Answer", duration: 0, sentiment: "Unknown", intent: "Unknown", summary: err.message } };
    await db.patch("dialertasks", orgId, taskId, {
      callResults, currentLeadId: null, currentCallStartedAt: null,
      autoDialStatus: "waiting", nextDialAt: new Date(Date.now() + INTER_CALL_DELAY_MS).toISOString(),
    }).catch(() => {});
  }
}

// Queue job: places exactly one outbound call. Deliberately never
// rethrows — a failed placement is a normal, expected outcome (busy
// signal, provider hiccup, compliance block), not a queue-level error to
// retry-with-backoff; dialerRetryEngine.js already owns business-level
// retry for a lead that didn't get through. Rethrowing here would also
// leave the task's currentLeadId claimed until the queue exhausts its own
// retries, stalling the whole task for no benefit.
async function handlePlaceDialJob(data) {
  const { orgId, taskId, leadId, leadName, leadPhone, taskName, provider, baseUrl, questions, language, from, agentId, starhealthEnabled, retryPolicy, autoDialRunId } = data;
  try {
    // The job sat in the queue briefly between being enqueued and actually
    // running — re-check the task wasn't stopped in that window (POST
    // .../auto-dial/stop flips autoDialEnabled immediately). Without this,
    // a Stop click landing in that gap would still place one more call
    // with no way to hang it up (forceHangupCurrentCall only knows about
    // calls that already have a providerCallSid).
    const tasksBeforeDial = await db.list("dialertasks", orgId);
    const taskBeforeDial = tasksBeforeDial.find((t) => t.id === taskId);
    if (!taskBeforeDial || !taskBeforeDial.autoDialEnabled || (autoDialRunId && taskBeforeDial.autoDialRunId !== autoDialRunId)) {
      log.info(`🤖 [autoDialEngine] Skipping queued dial for lead ${leadId} on task ${taskId} (org ${orgId}) — task was stopped before the job ran.`);
      await db.patch("dialertasks", orgId, taskId, { currentLeadId: null, currentCallStartedAt: null }).catch(() => {});
      return;
    }

    const result = await telephony.triggerOutboundCall(provider, orgId, leadPhone, {
      baseUrl, questions, language, from, agentId, starhealthEnabled, taskId, leadId, retryPolicy,
    });

    // The provider can answer/hang up very quickly. The finalizer may have
    // already completed this lead while triggerOutboundCall was returning.
    // Re-read the task before publishing the provider SID so a completed
    // final call cannot resurrect the task's in-flight lease and cause the
    // auto-dial loop to continue after the campaign is actually finished.
    const tasksAfterDial = await db.list("dialertasks", orgId);
    const taskAfterDial = tasksAfterDial.find((t) => t.id === taskId);
    if (!taskAfterDial || !taskAfterDial.autoDialEnabled || taskAfterDial.currentLeadId !== leadId ||
        (autoDialRunId && taskAfterDial.autoDialRunId !== autoDialRunId)) {
      // The stop request can race with the provider placement request. In that
      // window there is no provider SID yet for forceHangupCurrentCall() to
      // use, so if Vobiz did place the call after Stop, hang it up here.
      if (result?.callSid) {
        try {
          await telephony.hangupCall(provider, result.callSid, orgId);
          log.info(`🛑 [autoDialEngine] Hung up call ${result.callSid} because task ${taskId} was stopped during placement.`);
        } catch (hangupErr) {
          log.error(`❌ [autoDialEngine] Failed to cancel call ${result.callSid} after task ${taskId} was stopped:`, hangupErr.message);
        }
      }
      log.info(`🤖 [autoDialEngine] Call for lead ${leadId} completed/stopped before placement state could be committed; not resurrecting task ${taskId}.`);
      return;
    }

    await db.patch("dialertasks", orgId, taskId, { currentProviderCallSid: result.callSid, currentProvider: provider });
    if (global.broadcastLog) {
      global.broadcastLog(`🤖 Auto-dial: calling ${leadName || leadPhone} for task "${taskName}"`, {
        type: "auto_dial_progress", orgId, taskId, leadId, status: "dialing",
      });
    }
  } catch (err) {
    log.error(`❌ [autoDialEngine] Failed to dial lead ${leadId} for task ${taskId} (org ${orgId}):`, err.message);

    const insufficientBalance = isInsufficientRechargeBalanceError(err);
    const complianceBlocked = Number(err?.statusCode) === 403;

    if (complianceBlocked || insufficientBalance) {
      // Compliance and wallet blocks apply to the whole task. Wallet errors
      // are identified by a stable code/message as well as statusCode because
      // connector/error wrappers may preserve only part of the original Error.
      const reason = insufficientBalance ? "insufficient_balance" : "compliance_blocked";
      const severity = insufficientBalance ? "warning" : "error";

      try {
        await db.patch("dialertasks", orgId, taskId, {
          currentLeadId: null,
          currentProviderCallSid: null,
          currentCallStartedAt: null,
          autoDialEnabled: false,
          autoDialStatus: "paused",
          ...(insufficientBalance ? { autoDialBlockedReason: reason } : {}),
          nextDialAt: null,
          autoDialRunId: null,
        });
      } catch (patchErr) {
        log.error(`❌ [autoDialEngine] Failed to pause blocked task ${taskId} (org ${orgId}):`, patchErr.message);
      }

      if (global.broadcastLog) {
        global.broadcastLog(`🤖 Auto-dial task "${taskName}" paused — ${err.message}`, {
          type: "auto_dial_progress",
          orgId,
          taskId,
          status: "paused",
          reason,
          severity,
          message: err.message,
        });
      }
      return;
    }

    try {
      const tasks = await db.list("dialertasks", orgId);
      const currentTask = tasks.find((t) => t.id === taskId);
      const callResults = { ...((currentTask && currentTask.callResults) || {}), [leadId]: { status: "No Answer", duration: 0, sentiment: "Unknown", intent: "Unknown", summary: err.message } };
      await db.patch("dialertasks", orgId, taskId, {
        callResults, currentLeadId: null, currentCallStartedAt: null,
        autoDialStatus: "waiting", nextDialAt: new Date(Date.now() + INTER_CALL_DELAY_MS).toISOString(),
      });
    } catch (patchErr) {
      log.error(`❌ [autoDialEngine] Failed to record dial failure for lead ${leadId} on task ${taskId} (org ${orgId}):`, patchErr.message);
    }
  }
  // Never rethrow — see comment above.
}

let dialQueueRegistered = false;
function getDialQueue() {
  return getQueue();
}

async function processAutoDialTasks() {
  let tasks = [];
  try {
    tasks = await db.getActiveAutoDialTasks();
  } catch (err) {
    log.error("❌ [autoDialEngine] Failed to fetch active auto-dial tasks:", err.message);
    return;
  }
  for (const task of tasks) {
    try {
      await processTask(task);
    } catch (err) {
      log.error(`❌ [autoDialEngine] Unexpected error processing task ${task.id} (org ${task.orgId}):`, err.message);
    }
  }
}

// Immediately hangs up whatever call a task currently has in flight —
// called synchronously from POST /dialer-tasks/:id/auto-dial/stop (see
// src/routes/campaigns.js) so "Stop" actually terminates the live call
// right away instead of just stopping the NEXT one from being dialed and
// leaving the current one running until it ends on its own. Safe to call
// on a task with no in-flight call (no-op).
async function forceHangupCurrentCall(task) {
  if (!task.currentProviderCallSid) return;
  try {
    const provider = task.currentProvider || telephony.getDefaultProvider();
    await telephony.hangupCall(provider, task.currentProviderCallSid, task.orgId);
  } catch (err) {
    const message = String(err?.message || err || "");
    if (/call.*not found|not found.*call|does not exist|already.*ended|already.*hang/i.test(message)) {
      log.info(`ℹ️ [autoDialEngine] Call ${task.currentProviderCallSid} was already ended while stopping task ${task.id}; treating hangup as idempotent.`);
      return;
    }
    log.error(`❌ [autoDialEngine] Failed to force-hang-up call for task ${task.id} (org ${task.orgId}):`, message);
  }
}

function registerAutoDialWorker() {
  const queue = getQueue();
  if (!dialQueueRegistered) {
    queue.process("placeDial", handlePlaceDialJob, { concurrency: DIAL_CONCURRENCY });
    dialQueueRegistered = true;
  }
}

module.exports = { processAutoDialTasks, registerAutoDialWorker, forceHangupCurrentCall };
