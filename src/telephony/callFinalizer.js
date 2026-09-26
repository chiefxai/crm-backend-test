// src/telephony/callFinalizer.js
// ============================================================
// Shared "a call just ended" pipeline — everything that happens AFTER
// audio stops, independent of which telephony provider carried the call.
//
// Every provider proxy (vobizProxy.js, twilioProxy.js, piopiyProxy.js,
// geminiProxy.js) used to hand-roll its own copy of: merging streamed
// transcript fragments, matching/auto-creating a contact, generating the
// AI summary, extracting workflow Q&A, writing the call_logs row,
// broadcasting the live update, and metering AI-minutes usage. That
// duplication is exactly why the fragmented-transcript bug had to be
// found and fixed four separate times.
//
// A NEW telephony provider only ever needs to write the audio-protocol
// adapter (decode/encode audio, parse/build that provider's WS message
// shapes — genuinely provider-specific, no way around it) and call
// finalizeCallRecord() once its call ends. Everything below this line is
// shared and provider-agnostic.
// ============================================================

const db = require("../db/repository");
const objectsEngine = require("../crm/objectsEngine");
const postCallAgents = require("../ai/postCallAgents");
const { isMeaningfulCallerUtterance } = require("../ai/postCallAgents/decisionEngine");
const {
  findAdvisorCallbackResponse,
  resolveAdvisorCallbackIso,
  shouldSuppressDialerCallbackForAdvisorPreference,
} = require("../lib/advisorCallbackTime");
const { validateWorkflowAnswers } = require("../ai/postCallAgents/workflowAnswersAgent");
const storage = require("../storage");
const geminiUsageTracker = require("../ai/geminiUsageTracker");
const { getLogger } = require("../observability/logger");
const log = getLogger("telephony.callFinalizer");

const PENDING_SCHEDULE_STATUSES = ["Callback Scheduled", "No Answer", "Answering Machine"];

// Uploads a call's recording and returns its public URL (or null on failure/
// not configured). Deliberately NOT part of finalizeCallRecord below: the
// post-call pipeline now runs through a retryable job queue (see
// src/queue), and a temp PCM file gets deleted the moment it's read — a
// retried job re-running this step would find nothing to read. Each
// provider's finalizeCall() must call this ONCE, synchronously, before
// enqueueing the rest of the pipeline, and pass the resulting recordingUrl
// (a plain string — safe to carry in a queued job's data) into the queue.
function usableCallbackTime(iso) {
  const parsed = iso ? new Date(iso) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) return null;
  return parsed.toISOString();
}

function resolveConversationOutcome({ finalStatus, callAnswered, enquiryRequested, callbackRequested, transcript }) {
  if (finalStatus === "No Answer") return "no_answer";
  if (finalStatus === "Answering Machine") return "answering_machine";
  if (enquiryRequested) return callbackRequested ? "callback_and_enquiry" : "enquiry";
  if (finalStatus === "Callback Scheduled") return "callback_scheduled";
  if (callAnswered) {
    const text = String(transcript || "").toLowerCase();
    if (/\b(busy|not a good time|can't talk|cannot talk|unable to talk|call me later)\b/.test(text)) return "busy";
    return "completed";
  }
  return "completed";
}

// One validated post-call decision controls callback and enquiry actions.
function resolvePostCallOutcome({
  scheduling,
  isMachineDetected,
  attemptNumber = 1,
  retryContext,
  callAnswered = true,
  direction = "unknown",
  callerNumber = null,
  transcript = "",
}) {
  const decision = scheduling || {};
  const maxAttempts = db.MAX_RETRY_ATTEMPTS || 3;
  const retryPolicy = retryContext?.retryPolicy || db.DEFAULT_RETRY_POLICY;
  const requestedCallback = !!decision.callbackRequested && !!decision.callbackTime;
  const callbackExhausted = requestedCallback && attemptNumber >= maxAttempts;
  const callbackRequested = requestedCallback && !callbackExhausted;

  // Enquiries and retry-queue outcomes are mutually exclusive: a call waiting
  // for callback or no-answer redial must not also create an enquiry row.
  const enquiryRequested =
    !isMachineDetected &&
    callAnswered &&
    !callbackRequested &&
    !!decision.enquiryRequested &&
    !!decision.enquirySummary;

  let finalStatus = "Completed";
  let retryFieldsToSave = {};

  if (isMachineDetected) {
    finalStatus = "Answering Machine";
    retryFieldsToSave = { ...db.computeRetryFields(attemptNumber, retryPolicy, callerNumber), retryContext };
  } else if (!callAnswered && direction === "outbound") {
    // A caller who never engaged is a retryable "No Answer", never a
    // conversational callback. The Scheduling & Enquiry Agent is skipped
    // before this point when callAnswered=false.
    finalStatus = "No Answer";
    retryFieldsToSave = { ...db.computeRetryFields(attemptNumber, retryPolicy, callerNumber), retryContext };
  } else if (callbackRequested) {
    finalStatus = "Callback Scheduled";
    retryFieldsToSave = {
      attemptNumber,
      retryStatus: "pending",
      nextRetryAt: decision.callbackTime,
      retryContext,
    };
  } else if (callbackExhausted) {
    finalStatus = "Completed";
    retryFieldsToSave = {
      attemptNumber,
      retryStatus: "exhausted",
      nextRetryAt: null,
      retryContext,
    };
  }

  const conversationOutcome = resolveConversationOutcome({
    finalStatus,
    callAnswered,
    enquiryRequested,
    callbackRequested,
    transcript,
  });
  return {
    finalStatus,
    callbackRequested,
    enquiryRequested,
    conversationOutcome,
    callbackStatus: callbackRequested ? "scheduled" : "none",
    enquiryStatus: enquiryRequested ? "open" : "none",
    callbackTimeToStore: callbackRequested ? usableCallbackTime(decision.callbackTime) : null,
    callbackReasonToStore: callbackRequested
      ? (decision.callbackUsedPolicyFallback
        ? "Caller requested a callback; scheduled using the configured callback policy."
        : decision.callbackTimeMentioned
          ? "Caller requested a callback at a specific time."
          : "Callback scheduled from the call transcript.")
      : null,
    enquirySummary: enquiryRequested ? decision.enquirySummary : null,
    callerName: decision.callerName || null,
    retryFieldsToSave,
  };
}

async function uploadRecording(provider, callId, wavBuffer) {
  if (!storage.isConfigured()) {
    log.warn(`⚠️  [${provider}] recording not saved — STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY / STORAGE_BUCKET are not set.`);
    return null;
  }
  if (!wavBuffer || wavBuffer.length <= 44) return null; // header-only/empty — nothing to upload
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const url = await storage.upload(`recordings/${callId}.wav`, wavBuffer, { contentType: "audio/wav" });
      log.info(`💾 [${provider}] recording uploaded: ${url}`);
      return url;
    } catch (err) {
      log.error(`❌ [${provider}] upload error (attempt ${attempt}/2):`, err.message);
    }
  }
  return null;
}

// Gemini Live's incremental transcription pushes one entry per word/syllable
// chunk, not one per full utterance — merge consecutive same-speaker
// fragments into one turn so both the stored transcript and the text fed to
// postCallAgents read as an actual conversation instead of dozens of
// one-word lines.
function mergeTranscriptLines(transcriptLines) {
  const merged = [];
  for (const raw of (transcriptLines || [])) {
    if (!raw) continue;
    const role = raw.role === "user" ? "user" : "model";
    const text = String(raw.text || "").replace(/\\s+/g, " ").trim();
    if (!text) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      const a = last.text;
      const b = text;
      if (a === b || a.toLowerCase() === b.toLowerCase()) continue;
      const lowerA = a.toLowerCase();
      const lowerB = b.toLowerCase();
      if (lowerA.endsWith(lowerB)) continue;
      if (lowerB.startsWith(lowerA)) { last.text = b; continue; }
      let overlap = 0;
      const max = Math.min(a.length, b.length);
      for (let n = max; n >= 8; n--) {
        if (lowerA.slice(-n) === lowerB.slice(0, n)) { overlap = n; break; }
      }
      last.text = overlap ? a + b.slice(overlap) : a + " " + b;
    } else {
      merged.push({ role, text });
    }
  }
  return merged;
}

function buildFullTranscript(mergedLines) {
  return mergedLines
    .map(l => `${l.role === "user" ? "Caller" : "Agent"}: ${l.text.trim()}`)
    .join("\n");
}

// Links this call to an existing saved contact by phone match. Does NOT
// create a new contact for an unmatched number — contacts are only ever
// added explicitly, through the UI, not by the AI on its own. Orgs use
// either the lending leads table or the generic objects engine for
// contacts, never both, so try leads first and fall back to objects.
async function matchContact(orgId, callId, callerNumber, direction, extractedCallerName) {
  let leadId = null;
  let resolvedLeadName = null;
  try {
    const leadMatch = await db.findLeadByPhone(orgId, callerNumber);
    if (leadMatch) {
      leadId = leadMatch.id;
      resolvedLeadName = leadMatch.name || null;
    } else {
      const recordMatch = await objectsEngine.findRecordByPhone(orgId, callerNumber);
      if (recordMatch) {
        leadId = recordMatch.id;
        resolvedLeadName = recordMatch.name || null;
      }
    }
  } catch (err) {
    log.error("❌ [callFinalizer] contact match failed:", err.message);
  }

  // No matching contact — the AI no longer creates one on its own (that
  // used to happen here, and in save_contact_details/saveContactDetailsNow
  // below, both removed). A call from/to an unknown number now just
  // stays unlinked to a contact (call_logs.leadId null) instead of
  // silently adding a new Contact Directory entry; contacts are only
  // created explicitly, through the UI. Still resolve a name for the
  // call log DISPLAY, though, from whatever was captured live or by the
  // follow-up safety net — that's just a label, not a new row.
  if (!leadId) {
    try {
      resolvedLeadName = (await db.findCapturedNameForCall(orgId, callId)) || extractedCallerName || resolvedLeadName;
    } catch (err) {
      log.error("❌ [callFinalizer] captured-name lookup failed:", err.message);
    }
  }
  return { leadId, resolvedLeadName };
}

// Real-time contact lookup — called from a live tool (save_contact_details,
// declared in each provider's tool list) the moment a caller gives their
// name/email/location mid-call. Only UPDATES an existing contact's blank
// fields (never overwrites a name/email that's already saved with a new
// guess) — it no longer creates a new contact for an unmatched number; the
// AI has no power to add to Contact Directory on its own. Returns the
// resolved name so the live call can use it right away (e.g. if the
// number was already saved under a different name than what was just
// said, the AI should use the ALREADY-SAVED one, not silently rename it).
async function saveContactDetailsNow(orgId, callerNumber, direction, { name, email, location } = {}) {
  if (!orgId || !callerNumber) return { saved: false, resolvedName: name || null };
  try {
    const leadMatch = await db.findLeadByPhone(orgId, callerNumber);
    if (leadMatch) {
      const patch = {};
      if (!leadMatch.name && name) patch.name = name;
      if (!leadMatch.email && email) patch.email = email;
      if (Object.keys(patch).length > 0) await db.patch("leads", orgId, leadMatch.id, patch);
      return { saved: true, leadId: leadMatch.id, resolvedName: leadMatch.name || name || null, alreadyKnown: true };
    }
    const recordMatch = await objectsEngine.findRecordByPhone(orgId, callerNumber);
    if (recordMatch) {
      return { saved: true, leadId: recordMatch.id, resolvedName: recordMatch.name || name || null, alreadyKnown: true };
    }
    // Unmatched number: no longer creates a new contact — just report
    // the name back so the live call can use it in conversation, without
    // adding anything to Contact Directory.
    return { saved: false, resolvedName: name || null };
  } catch (err) {
    log.error("❌ [callFinalizer] saveContactDetailsNow failed:", err.message);
    return { saved: false, resolvedName: name || null };
  }
}

/**
 * Runs the full post-call pipeline and writes the call_logs row. Call this
 * once, after audio/recording handling is done, regardless of provider.
 *
 * Required:
 *   provider          "vobiz" | "twilio" | "piopiy" | <your new provider> — log label only
 *   orgId             org this call belongs to (no-op if falsy — e.g. dev/browser sessions with no org)
 *   callId            this call's internal id
 *   callerNumber      normalized caller phone number
 *   direction         "inbound" | "outbound"
 *   durationSeconds   call length
 *   sentiment         result of postCallAgents.analyzeSentiment(...).sentiment
 *   recordingUrl      storage URL, or null if upload failed/skipped
 *   transcriptLines   RAW streaming fragments — this function merges them
 *
 * Optional:
 *   extractedCallerName   name pulled by a provider's own follow-up safety net, if any
 *   getWorkflowQuestions  () => string[] | null — questions for Q&A extraction; omit if the
 *                         provider has no wizard-assigned workflow questions for this call
 *   isMachineDetected     vobiz-style answering-machine detection (default false)
 *   attemptNumber         auto-redial attempt number, only meaningful with isMachineDetected
 *   retryContext          auto-redial context to persist, only meaningful with isMachineDetected
 *   sentimentInputTokens/sentimentOutputTokens  token usage from a sentiment
 *                         analysis the caller already ran itself (vobizProxy.js
 *                         does, for its own save_enquiry safety net) — folded
 *                         into this call's "gemini-postcall" cost-tracking
 *                         session below alongside summary/workflow-answers/
 *                         follow-up, instead of being paid for twice or lost.
 *
 * Returns { fullTranscript, mergedTranscriptLines } in case the caller needs
 * them for anything provider-specific — the DB write and broadcast happen
 * internally and are fire-and-forget, matching prior behavior.
 */
async function finalizeCallRecord({
  provider,
  orgId,
  callId,
  callerNumber,
  direction,
  durationSeconds,
  sentiment,
  recordingUrl,
  transcriptLines,
  extractedCallerName = null,
  getWorkflowQuestions = () => null,
  isMachineDetected = false,
  attemptNumber = 1,
  retryContext = null,
  providerCallSid = null,
  // Precomputed by the caller (currently only vobizProxy.js, which already
  // runs this for its own save_enquiry safety net) to avoid a duplicate
  // LLM call — if omitted and there's a transcript, computed here instead
  // so every provider gets the "caller asked to be called back" handling
  // below, not just Vobiz.
  followUp = null,
  sentimentInputTokens = 0,
  sentimentOutputTokens = 0,
}) {
  // Accumulates token usage across every post-call agent this function
  // runs (sentiment's is seeded in from the caller above; follow-up/
  // workflow-answers/summary below add to it via onUsage) into ONE
  // "gemini-postcall" ai_session_usage row per call — see the tracking
  // call near the bottom of this function. Kept separate from the live
  // voice session's own usage row (provider "gemini") since these are a
  // different, far cheaper model (gemini-2.5-flash-lite) and should show
  // as their own cost line, not blended into voice-session cost.
  // Legacy providers may still pass "Unknown". Persist the new canonical null\n  // value so busy/callback calls are never treated as negative/neutral.\n  sentiment = sentiment === "Unknown" ? null : sentiment;\n\n  // Keep post-call usage in one explicit object so every agent contributes
  // to the same metering bucket without relying on ad-hoc local variables.
  // This also makes the final usage payload impossible to reference before
  // declaration when the finalizer evolves.
  const postCallUsage = {
    inputTokens: Number(sentimentInputTokens) || 0,
    outputTokens: Number(sentimentOutputTokens) || 0,
  };
  if (transcriptLines?.length) {
    log.info(
      `🧩 [${provider}] Post-call pipeline version=${postCallAgents.POST_CALL_PIPELINE_VERSION || "unknown"}`
    );
  }
  const accumulateUsage = ({ inputTokens = 0, outputTokens = 0 } = {}) => {
    postCallUsage.inputTokens += Number(inputTokens) || 0;
    postCallUsage.outputTokens += Number(outputTokens) || 0;
  };
  const mergedTranscriptLines = mergeTranscriptLines(transcriptLines);
  const fullTranscript = buildFullTranscript(mergedTranscriptLines);

  if (!orgId) return { fullTranscript, mergedTranscriptLines };

  const transcriptForUi = mergedTranscriptLines.map(l => ({
    speaker: l.role === "user" ? "Customer" : "AI",
    text: l.text.trim(),
    timestamp: new Date().toTimeString().split(" ")[0],
  }));

  // Any finalized caller speech means the call was answered for purposes
  // of conversational post-processing. A zero-word caller transcript is
  // kept out of the conversational callback/enquiry pipeline so no-answer
  // and machine outcomes remain separate.
  const callerWordCount = mergedTranscriptLines
    .filter((l) => l.role === "user" && isMeaningfulCallerUtterance(l.text))
    .reduce((sum, l) => sum + l.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const callAnswered = !isMachineDetected && callerWordCount > 0;

  let { leadId, resolvedLeadName } = await matchContact(orgId, callId, callerNumber, direction, extractedCallerName);

  // Lead promotion is intentionally deferred until after sentiment,
  // callback, and enquiry decisions. Answering a call alone is not enough
  // to move a contact into Leads.

  // Post-call agents are independent. Run them concurrently so one slow
  // generation never serializes the entire pipeline. Each agent has its own
  // fallback and failure boundary; deterministic validation below is the only
  // authority for actions.
  let callAnswers = [];
  let workflowQuestions = getWorkflowQuestions();
  let workflowValidation = { complete: true, missingQuestions: [], requiredQuestions: [] };

  try { callAnswers = await db.getResponsesByCallId(orgId, callId); } catch (err) {
    log.warn(`⚠️ [${provider}] workflow response lookup failed; continuing without saved answers:`, err.message);
  }

  log.info(
    `🔧 [${provider}] Post-call inputs: transcriptLines=${transcriptLines?.length || 0}, normalizedTranscriptLines=${mergedTranscriptLines.length}, workflowQuestions=${workflowQuestions?.length || 0}, callerWordCount=${callerWordCount}`
  );

  const workflowPromise = (workflowQuestions?.length && transcriptLines.length > 0)
    ? (async () => {
        const startedAt = Date.now();
        try {
          const extractedAnswers = await postCallAgents.extractWorkflowAnswers(
            fullTranscript,
            workflowQuestions,
            orgId,
            accumulateUsage
          );

          const existingByQuestion = new Map(
            (callAnswers || [])
              .filter((row) => row?.question)
              .map((row) => [String(row.question).trim().toLowerCase(), row])
          );

          // Live-saved answers are authoritative. Transcript extraction only
          // fills questions that are absent or blank.
          for (const answerRow of extractedAnswers || []) {
            if (!answerRow?.question) continue;
            const key = String(answerRow.question).trim().toLowerCase();
            const existing = existingByQuestion.get(key);
            const existingAnswer = existing?.answer == null ? "" : String(existing.answer).trim();

            if (!existing || !existingAnswer) {
              if (!existing) {
                callAnswers.push(answerRow);
              } else {
                existing.answer = answerRow.answer || "";
                existing.label = existing.label || answerRow.label || answerRow.question;
              }

              if (answerRow.answer != null && String(answerRow.answer).trim()) {
                db.create("leadresponses", orgId, {
                  callId,
                  question: answerRow.question,
                  answer: answerRow.answer,
                  label: answerRow.label || answerRow.question,
                  createdAt: new Date().toISOString(),
                }).catch((err) => log.warn(`⚠️ [${provider}] workflow answer persistence failed:`, err.message));
              }
            }
          }
          log.info(`🧠 [${provider}] Workflow agent completed in ${Date.now() - startedAt}ms; answers=${extractedAnswers?.length || 0}`);
        } catch (err) {
          log.error(`❌ [${provider}] workflow answer extraction failed; continuing call finalization:`, err.message);
        }
      })()
    : (log.info(`⏭️ [${provider}] Workflow agent skipped: no workflow questions assigned to this call.`), Promise.resolve());

  const summaryPromise = transcriptLines.length > 0
    ? (async () => {
        const startedAt = Date.now();
        try {
          // Summary is descriptive only. It does not need workflow answers and
          // must not become a dependency for callback/enquiry decisions.
          const result = await postCallAgents.generateCallSummary(
            fullTranscript,
            orgId,
            [],
            accumulateUsage,
            callerNumber
          );
          log.info(`📝 [${provider}] Summary agent completed in ${Date.now() - startedAt}ms`);
          return result;
        } catch (err) {
          log.error(`❌ [${provider}] post-call summary failed; continuing call finalization:`, err.message);
          return null;
        }
      })()
    : Promise.resolve(null);

  const existingScheduling = followUp && Object.prototype.hasOwnProperty.call(followUp, "callbackTimeMentioned")
    ? followUp
    : null;

  const schedulingPromise = (!isMachineDetected && callAnswered && transcriptLines.length > 0 && !existingScheduling)
    ? (async () => {
        const startedAt = Date.now();
        try {
          // Scheduling is transcript-first. Summary/sentiment are deliberately
          // not required inputs so this agent can run in parallel and cannot
          // inherit a model-generated decision from another agent.
          const result = await postCallAgents.extractFollowUp(
            fullTranscript,
            orgId,
            callerNumber,
            accumulateUsage,
            {
              sentiment,
              summary: "(Independent transcript-first decision; do not infer actions from summary.)",
              callAnswered,
              retryPolicy: retryContext?.retryPolicy,
              attemptNumber,
            }
          );
          log.info(`📅 [${provider}] Scheduling agent completed in ${Date.now() - startedAt}ms`);
          return result;
        } catch (err) {
          log.error(`❌ [${provider}] scheduling/enquiry extraction failed; continuing call finalization:`, err.message);
          return null;
        }
      })()
    : Promise.resolve(existingScheduling);

  const [workflowResult, postCallSummary, schedulingResult] = await Promise.allSettled([
    workflowPromise,
    summaryPromise,
    schedulingPromise,
  ]);

  // Never let one post-call agent failure abort call persistence.
  if (workflowResult.status === "rejected") {
    log.error(`❌ [${provider}] workflow agent promise rejected:`, workflowResult.reason?.message || workflowResult.reason);
  }
  if (postCallSummary && postCallSummary.status === "rejected") {
    log.error(`❌ [${provider}] summary agent promise rejected:`, postCallSummary.reason?.message || postCallSummary.reason);
  }
  if (schedulingResult.status === "rejected") {
    log.error(`❌ [${provider}] scheduling agent promise rejected:`, schedulingResult.reason?.message || schedulingResult.reason);
  }

  // Workflow validation runs only after extraction has settled.
  if (workflowQuestions?.length) {
    workflowValidation = validateWorkflowAnswers(workflowQuestions, callAnswers);
    if (!workflowValidation.complete) {
      log.warn(
        `⚠️ [${provider}] Workflow incomplete for call ${callId}; lead creation/promotion blocked. Missing: ${workflowValidation.missingQuestions.map((q) => q.label || q.question).join(", ")}`
      );
    }
  }

  let aiSummary = fullTranscript.slice(0, 500);
  if (postCallSummary.status === "fulfilled" && postCallSummary.value) {
    aiSummary = postCallSummary.value.text;
  }

  let scheduling = null;
  if (!isMachineDetected && callAnswered && transcriptLines.length > 0) {
    scheduling = schedulingResult.status === "fulfilled" ? schedulingResult.value : null;
  }

  scheduling = scheduling || {
    callbackRequested: false,
    callbackTimeMentioned: false,
    callbackTime: null,
    callbackUsedPolicyFallback: false,
    enquiryRequested: false,
    enquirySummary: null,
    callerName: null,
  };

  const advisorCallbackRow = findAdvisorCallbackResponse(callAnswers);
  let leadAdvisorCallbackTime = null;
  if (advisorCallbackRow && callAnswered) {
    try {
      leadAdvisorCallbackTime = await resolveAdvisorCallbackIso({
        answer: advisorCallbackRow.answer,
        question: advisorCallbackRow.question,
        callerPhone: callerNumber,
        orgId,
        onUsage: accumulateUsage,
      });
      if (leadAdvisorCallbackTime) {
        const targetLeadId = leadId || (callerNumber ? (await db.findLeadByPhone(orgId, callerNumber).catch(() => null))?.id : null);
        if (targetLeadId) {
          await db.patch("leads", orgId, targetLeadId, {
            callbackTime: leadAdvisorCallbackTime,
            updatedAt: new Date().toISOString(),
          });
          if (!leadId) leadId = targetLeadId;
          log.info(`📅 [${provider}] Saved human advisor callback preference on lead ${targetLeadId}: ${leadAdvisorCallbackTime}`);
        }
      }
    } catch (err) {
      log.error(`❌ [${provider}] Failed to save advisor callback time on lead:`, err.message);
    }
  }

  if (shouldSuppressDialerCallbackForAdvisorPreference(fullTranscript, !!advisorCallbackRow)) {
    scheduling = {
      ...scheduling,
      callbackRequested: false,
      callbackTime: null,
      callbackUsedPolicyFallback: false,
      callbackTimeMentioned: false,
    };
  }

  const {
    finalStatus, callbackRequested, enquiryRequested, callbackTimeToStore, callbackReasonToStore,
    enquirySummary, callerName: outcomeCallerName, conversationOutcome: initialConversationOutcome,
    callbackStatus, enquiryStatus, retryFieldsToSave,
  } = resolvePostCallOutcome({
    scheduling,
    isMachineDetected,
    attemptNumber,
    retryContext,
    callAnswered,
    direction,
    callerNumber,
    transcript: fullTranscript,
  });

  const conversationOutcome = resolveConversationOutcome({
    finalStatus,
    callAnswered,
    enquiryRequested,
    callbackRequested: !!callbackTimeToStore,
    transcript: fullTranscript,
  });

  if (enquiryRequested && enquirySummary) {
        try {
          const existing = await db.list("enquiries", orgId);
          const alreadySaved = (existing || []).some(e => String(e.callId || e.call_id || "") === String(callId));
          if (!alreadySaved) {
            await db.create("enquiries", orgId, {
              callId,
              name: outcomeCallerName || resolvedLeadName || null,
              phone: callerNumber || null,
              queryText: enquirySummary,
              status: "new",
              createdAt: new Date().toISOString(),
            });
            log.info(`✅ [${provider}] Post-call saved enquiry for call ${callId}`);
          }
        } catch (err) {
          log.error(`❌ [${provider}] Post-call enquiry save failed:`, err.message);
        }
  }

  // A genuinely positive, fully successful conversation becomes a Lead.
  // This is intentionally evaluated only after the post-call Scheduling &
  // Enquiry Agent has finished: a busy callback or unresolved enquiry is not
  // treated as a fully-qualified lead yet.
  const retryQueued =
    finalStatus === "Callback Scheduled" ||
    finalStatus === "No Answer" ||
    finalStatus === "Answering Machine";

  const positiveLeadCandidate =
    sentiment === "Positive" &&
    callAnswered &&
    !retryQueued &&
    !enquiryRequested &&
    !callbackTimeToStore &&
    workflowValidation.complete;

  if (!workflowValidation.complete) {
    log.info(
      `🚫 [${provider}] Lead creation/promotion skipped for call ${callId}: mandatory workflow data is incomplete.`
    );
  }

  if (positiveLeadCandidate) {
    try {
      if (leadId) {
        const current = await db.getLeadById(orgId, leadId).catch(() => null);
        if (current && (!current.pipelineStage ||
          current.pipelineStage === "contact" ||
          current.pipelineStage === "campaign" ||
          current.pipelineStage === "lead")) {
          const updated = await db.patch("leads", orgId, leadId, {
            pipelineStage: "lead",
            status: current.status || "New",
          });
          resolvedLeadName = updated?.name || resolvedLeadName;
          log.info(`🎯 [${provider}] Positive call promoted existing contact ${leadId} to Leads`);
        }
      } else if (callerNumber) {
        // Positive calls from a brand-new number should also appear in the
        // Leads section. Use the phone as the dedupe key before creating.
        const existing = await db.findLeadByPhone(orgId, callerNumber);
        if (existing) {
          leadId = existing.id;
          resolvedLeadName = existing.name || resolvedLeadName;
          await db.patch("leads", orgId, leadId, { pipelineStage: "lead" }).catch(() => {});
        } else {
          const created = await db.create("leads", orgId, {
            name: outcomeCallerName || extractedCallerName || resolvedLeadName || "Unknown Caller",
            phone: callerNumber,
            source: "voice_ai",
            status: "New",
            pipelineStage: "lead",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          leadId = created.id;
          resolvedLeadName = created.name || resolvedLeadName;
          log.info(`🎯 [${provider}] Positive call created new Lead ${leadId} for ${callerNumber}`);
        }
      }
    } catch (err) {
      // Lead promotion must never make an otherwise completed call fail.
      log.error(`❌ [${provider}] Positive-call lead promotion failed:`, err.message);
    }
  }

  // This used to be fire-and-forget (db.create(...).then().catch(), never
  // awaited) — matched prior behavior, but meant a genuine failure OR a
  // hang here was invisible: the caller (processPostCallData, run by the
  // job queue) had already returned by the time this settled, so the queue
  // marked the job a success and never retried, and a stuck/slow insert
  // left NEITHER the "Call logged" success line NOR the "insert error"
  // failure line in the logs — confirmed directly from a production
  // capture where a call's sentiment/cost breakdown both logged normally,
  // then nothing: no call_logs row, no call_completed broadcast, no error
  // anywhere, for over a minute. The frontend's dialer UI (which only
  // advances on that broadcast) and Call Logs / the recording's visibility
  // (which both depend on this row actually existing — the recording
  // itself had already uploaded fine) were both silently stuck as a
  // result.
  //
  // Now: awaited, with a hard timeout so a hung request can't block
  // forever, and re-thrown on failure so the queue's own 3-attempt/backoff
  // retry actually gets a chance to recover a transient DB issue instead
  // of the job being marked done regardless.
  const CALL_LOG_INSERT_TIMEOUT_MS = 20_000;
  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);

  // Durable completion boundary: only the call-log DB write is retryable.
  // Post-persistence side effects must never replay the whole finalizer.
  let savedLog = null;
  try {
    savedLog = await withTimeout(
      db.create("calllogs", orgId, {
        id: callId,
        leadId,
        leadName: resolvedLeadName || callerNumber,
        callerNumber,
        duration: durationSeconds,
        status: finalStatus,
        sentiment,
        intent: "Unknown",
        transcript: transcriptForUi,
        summary: aiSummary,
        recordingUrl,
        direction,
        createdAt: new Date().toISOString(),
        providerCallSid,
        callbackTime: callbackTimeToStore,
        callbackReason: callbackReasonToStore,
        callAnswered,
        conversationOutcome,
        callbackStatus,
        enquiryStatus,
        ...retryFieldsToSave,
      }),
      CALL_LOG_INSERT_TIMEOUT_MS,
      `[${provider}] calllogs insert for call ${callId}`
    );
    log.info(`📼 [${provider}] Call logged: ${callerNumber} (${durationSeconds}s, ${sentiment})`);
    if (savedLog && PENDING_SCHEDULE_STATUSES.includes(finalStatus)) {
      await db.supersedeConflictingPendingCallLogs(orgId, savedLog);
    }
  } catch (err) {
    const duplicate = /duplicate entry|duplicate key|unique constraint|already exists/i.test(err.message || "");
    if (duplicate) {
      try {
        savedLog = (await db.list("calllogs", orgId)).find(row => String(row.id) === String(callId)) || null;
      } catch (lookupErr) {
        log.error(`❌ [${provider}] Existing call log lookup failed for ${callId}:`, lookupErr.message);
      }
      if (!savedLog) throw err;
      log.warn(`⚠️ [${provider}] Call log ${callId} already exists; continuing idempotently.`);
    } else {
      log.error(`❌ [${provider}] call_logs insert error for call ${callId}:`, err.message);
      throw err;
    }
  }

  // Everything after persistence is best-effort. Failure here must not make
  // RabbitMQ replay a call whose DB row already exists.
  try {
    if (global.broadcastLog && savedLog) {
      const answersMap = Object.fromEntries((callAnswers || []).map((a) => [a.label || a.question, a.answer]));
      let resolvedRecordingUrl = savedLog.recordingUrl;
      try {
        resolvedRecordingUrl = await storage.resolvePlaybackUrl(savedLog.recordingUrl);
      } catch (urlErr) {
        log.warn(`⚠️ [${provider}] Recording URL resolution failed for ${callId}; using stored URL.`, urlErr.message);
      }
      const enrichedLog = { ...savedLog, recordingUrl: resolvedRecordingUrl, answers: answersMap };
      global.broadcastLog(`📼 [${provider}] Call logged: ${callerNumber} (${durationSeconds}s, ${sentiment})`, { type: "call_completed", orgId, callLog: enrichedLog, providerCallSid });
    }
    if (finalStatus === "Callback Scheduled") {
      log.info(`📅 [${provider}] Callback scheduled for ${callerNumber} — next attempt ${retryFieldsToSave.nextRetryAt}`);
    }
  } catch (err) {
    log.error(`⚠️ [${provider}] Post-persistence notification failed for ${callId}:`, err.message);
  }

  // If this call was placed for a dialer task (retryContext.taskId/leadId —
  // set at trigger time by autoDialEngine.js or a manual dial; carried
  // forward across redials by dialerRetryEngine.js), reflect this call's
  // outcome directly on that task's row so DialerSimulator.tsx's Active
  // Working List shows it without needing to separately poll/match by
  // phone or provider call id. This is what closes the loop for a
  // scheduled callback: the ORIGINAL call sets the lead to "Callback
  // Scheduled", and — independently, whenever that automatic redial later
  // actually happens — this same code path runs again for the NEW call
  // and flips the same lead to "Completed" (or back to "Callback
  // Scheduled" again, if the caller was busy a second time).
  if (retryContext?.taskId && retryContext?.leadId) {
    try {
      const tasks = await db.list("dialertasks", orgId);
      const task = tasks.find(t => t.id === retryContext.taskId);
      if (task) {
        const callResults = { ...(task.callResults || {}) };
        callResults[retryContext.leadId] = {
          status: finalStatus,
          duration: durationSeconds,
          sentiment,
          intent: "Unknown",
          summary: aiSummary,
          recordingUrl,
          callId,
          callbackTime: callbackTimeToStore,
          callbackReason: callbackReasonToStore,
          callAnswered,
          conversationOutcome,
          callbackStatus,
          enquiryStatus,
          // Calls placed through the job queue (autoDialEngine.js's
          // continuous dialer, dialerRetryEngine.js's auto-redials) land
          // here instead of DialerSimulator.tsx's own handleHangupCall,
          // which is the only other place this object gets built — and
          // that one DOES attach `answers` (converted from callAnswers'
          // {label,question,answer}[] into the {[label]: answer} map the
          // "Extracted Campaign Answers" panel indexes into). Missing here
          // meant every auto-dialed/auto-redialed call — now the primary
          // calling path — showed "No answer captured" for every workflow
          // variable regardless of labeling, since the panel had nothing
          // to look up at all.
          answers: Object.fromEntries((callAnswers || []).map((a) => [a.label || a.question, a.answer])),
        };
        // A completed call must release the task's in-flight lease here, not
        // only via the auto-dial poller. The poller discovers completion by
        // looking up call_logs, so waiting for another poll creates a race
        // where the UI/task can remain in "dialing" even though this call is
        // already finalized. Clearing the provider SID also makes it
        // idempotent: a later scheduler tick cannot treat the same call as
        // still active and re-process it.
        //
        // Important: if this was the final lead, finish the auto-dial task
        // here instead of waiting for a later poll. This also closes the
        // race with handlePlaceDialJob(), which can return from the provider
        // call after the finalizer has already cleared the in-flight lease.
        const remainingPending = (task.leadIds || []).some((leadId) => {
          const result = callResults[leadId];
          return !result || result.status === "Pending";
        });
        const waitingForCallbacks = !remainingPending && (task.leadIds || []).some((leadId) => {
          const result = callResults[leadId];
          return result && result.status === "Callback Scheduled";
        });
        const taskFinished = !remainingPending && !waitingForCallbacks;

        // A completed call must always stop Auto Dial. Auto Dial is
        // explicitly user-controlled; finishing one call must not silently
        // schedule the next lead. Scheduled callbacks remain owned by the
        // callback/retry engine and do not require autoDialEnabled.
        await db.patch("dialertasks", orgId, retryContext.taskId, {
          callResults,
          currentLeadId: null,
          currentProviderCallSid: null,
          currentProvider: null,
          currentCallStartedAt: null,
          autoDialEnabled: false,
          autoDialStatus: taskFinished ? "completed" : (waitingForCallbacks ? "waiting_for_callbacks" : "paused"),
          nextDialAt: null,
        });

        if (taskFinished && global.broadcastLog) {
          global.broadcastLog(`🤖 Auto-dial task "${task.name}" completed — every lead has been dialed.`, {
            type: "auto_dial_progress",
            orgId,
            taskId: retryContext.taskId,
            status: "task_completed",
          });
        }
      }
    } catch (err) {
      log.error(`❌ [${provider}] Failed to update task ${retryContext.taskId} callResults for lead ${retryContext.leadId}:`, err.message);
    }
  }

  db.incrementAiMinutesUsed(orgId, durationSeconds).catch(err =>
    log.error(`❌ [${provider}] AI-minutes metering error:`, err.message)
  );
  db.incrementPhoneCharges(orgId, durationSeconds).catch(err =>
    log.error(`❌ [${provider}] Phone-charges metering error:`, err.message)
  );

  // Cost-track the post-call agents (sentiment, follow-up, workflow-
  // answers, summary — whichever actually ran for this call) as their own
  // "gemini-postcall" ai_session_usage row, priced against that AI cost
  // provider's rate (see platform/costProviders.js) separately from the
  // live voice session. A single start->record->finalize sequence, not
  // truly "live", since all the usage is already known post-hoc — reuses
  // the exact same tracked pipeline/schema the voice session uses rather
  // than a parallel one-off cost calculation. Fire-and-forget, same as
  // the metering calls above: usage tracking must never fail call
  // finalization.
  log.info(
    `📊 [${provider}] Post-call usage total: inputTokens=${postCallUsage.inputTokens}, outputTokens=${postCallUsage.outputTokens}`
  );

  if (postCallUsage.inputTokens > 0 || postCallUsage.outputTokens > 0) {
    geminiUsageTracker.startUsageSession({
      orgId, callId, provider: "post-call-agents", model: postCallAgents.MODEL, costProviderKey: "gemini-postcall",
    }).then(async (handle) => {
      if (!handle) return;
      await geminiUsageTracker.recordUsage(handle, {
        inputTokens: postCallUsage.inputTokens,
        outputTokens: postCallUsage.outputTokens,
      });
      await geminiUsageTracker.finalizeUsageSession(handle);
    }).catch(err => log.error(`❌ [${provider}] post-call-agents usage tracking error:`, err.message));
  }

  return { fullTranscript, mergedTranscriptLines };
}

module.exports = { finalizeCallRecord, mergeTranscriptLines, buildFullTranscript, uploadRecording, saveContactDetailsNow, resolvePostCallOutcome };