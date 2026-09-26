// services/dialerRetryEngine.js
// ============================================================
// Automatic redial for outbound Vobiz calls that ended in "No Answer" or
// "Answering Machine". Previously these just sat in the dashboard forever
// until someone manually clicked "Redial" — this polls for calls whose
// scheduled retry delay has elapsed and re-dials them itself, up to
// db.MAX_RETRY_ATTEMPTS total attempts (see db.computeRetryFields).
// ============================================================

const db = require("../db/repository");
const { getQueue } = require("../queue");
const { getLogger } = require("../observability/logger");
const log = getLogger("crm.dialerRetryEngine");

// Real cron schedule (was a bare setInterval) — every 5 minutes, on the
// clock (:00, :05, :10, ...) rather than 5 minutes after whenever the
// process happened to boot. `noOverlap: true` is node-cron's own
// safeguard against a slow run still going when the next tick fires —
// processDueRetries() already tolerates re-entrancy fine on its own
// (every row is claimed via retryStatus "retrying" before it's acted on,
// same discipline as autoDialEngine.js), but skipping an overlapping run
// outright is simpler and cheaper than relying on that claim to sort
// itself out under load.
// Placing the actual redial call runs through the same job-queue
// infrastructure autoDialEngine.js and the post-call pipeline use — see
// autoDialEngine.js's identical comment for why (bounded parallelism
// instead of every redial across the platform serialized behind one poll
// tick; one placement attempt per job, never rethrown, since a failed
// redial already has its own handling below).
const REDIAL_CONCURRENCY = 5;

function getPublicBaseUrl() {
  // See autoDialEngine.js's identical function for why DOMAIN is a safe
  // fallback: any deployment serving HTTPS via Caddy's automatic-TLS setup
  // already has it set (Caddyfile/Caddyfile.uat use `{$DOMAIN}`), so this
  // engine no longer needs PUBLIC_URL specifically configured on top of
  // whatever's already required for the deployment to serve HTTPS at all.
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  if (process.env.DOMAIN) return `https://${process.env.DOMAIN}`;
  return null;
}

async function processDueRetries() {
  try {
    const recovered = await db.recoverStaleRetryClaims();
    if (recovered) {
      log.warn(`♻️ [dialerRetryEngine] Recovered ${recovered} stale retry claim(s) after scheduler restart.`);
    }
  } catch (err) {
    log.error("❌ [dialerRetryEngine] Failed to recover stale retry claims:", err.message);
  }

  // RabbitMQ can be temporarily unavailable exactly when a callback becomes due.
  // Do not consume the one-shot BullMQ wake-up in that case. The durable queue
  // adapter buffers publishes and flushes them after reconnect.
  const queue = getRedialQueue();

  let due = [];
  try {
    due = await db.getCallsDueForRetry();
  } catch (err) {
    log.error("❌ [dialerRetryEngine] Failed to fetch calls due for retry:", err.message);
    return;
  }

  for (const row of due) {
    try {
      // Skip if this lead was already reached (or is already being retried)
      // through a NEWER call than the one this pending row came from —
      // otherwise a manual "Redial" click, another retry chain for the same
      // number, or the lead calling back in the meantime never gets
      // noticed, and this stale row keeps auto-redialing someone who
      // already got through. Confirmed live: two independent retry chains
      // for the same number ran in parallel and kept calling a lead who
      // had already had a full, successful 91-second conversation.
      // callFinalizer.js writes leadName as the matched CONTACT's name
      // when one exists (resolvedLeadName || callerNumber) — only calls
      // with no lead match end up with a phone number in leadName at all.
      // callerNumber is the one field on this row guaranteed to actually
      // be a dialable number regardless. Redialing row.leadName directly
      // would try to place a call to "John Smith" for any callback/no-
      // answer/machine row that DID match a real lead — confirmed this
      // was already silently broken for "No Answer"/"Answering Machine"
      // retries before this fix (same underlying row shape), not just the
      // "Callback Scheduled" case this variable was renamed for.
      const dialTarget = row.callerNumber || row.leadName;
      const campaignTaskId = row.retryContext?.taskId || null;
      const alreadyHandled = await db.hasNewerCallForPhone(
        row.orgId,
        dialTarget,
        row.createdAt,
        row.id,
        campaignTaskId
      );
      if (alreadyHandled) {
        log.info(`🔁 [dialerRetryEngine] Skipping redial for ${row.leadName} (org ${row.orgId}) — a newer call to this number already exists.`);
        await db.patch("calllogs", row.orgId, row.id, { retryStatus: "superseded" });
        continue;
      }

      // Atomically claim the retry in MySQL. This prevents two scheduler
      // instances from placing the same redial during a rolling deploy. The
      // claim also re-checks that no newer call to the same number exists.
      const claimed = await db.claimCallForRetry(row.orgId, row.id);
      if (!claimed) {
        await db.patch("calllogs", row.orgId, row.id, { retryStatus: "superseded" }).catch(() => {});
        continue;
      }

      const baseUrl = getPublicBaseUrl();
      if (!baseUrl) {
        log.error("❌ [dialerRetryEngine] No PUBLIC_URL configured — cannot build callback URLs for auto-redial. Marking exhausted instead of retrying forever.");
        await db.patch("calllogs", row.orgId, row.id, { retryStatus: "exhausted" });
        continue;
      }

      const nextAttempt = (row.attemptNumber || 1) + 1;
      log.info(`🔁 [dialerRetryEngine] Auto-redialing ${row.leadName} (org ${row.orgId}) — attempt ${nextAttempt}, previous outcome: ${row.status}`);

      // Redial with the SAME task-specific questions/language/assigned
      // contact the original dial used (saved onto this row at the time —
      // see vobizProxy.js's vobizCallRetryContext), not the org's generic
      // default questionnaire.
      const retryContext = row.retryContext || {};
      // Row is already claimed (retryStatus "retrying" above) — hand the
      // actual placement to the queue and move on to the next due row
      // instead of waiting on this one's HTTP round-trip to the provider.
      getRedialQueue().enqueue("placeRedial", {
        orgId: row.orgId, rowId: row.id, dialTarget, leadName: row.leadName,
        baseUrl, attemptNumber: nextAttempt,
        questions: retryContext.questions, from: retryContext.from, language: retryContext.language,
        assignedContact: retryContext.assignedContact,
        retryPolicy: retryContext.retryPolicy || null,
        // Forward taskId/leadId (present when the original call — or an
        // earlier hop of this same retry chain — was placed for a dialer
        // task) so callFinalizer.js can keep patching that task's
        // callResults for this lead no matter how many redials it takes.
        // Without this, a lead scheduled for a "call me back at 6pm"
        // callback would flip to "Completed" in call_logs once actually
        // reached, but the dialer task's own Active Working List row
        // would stay stuck on "Callback Scheduled" forever.
        taskId: retryContext.taskId, leadId: retryContext.leadId,
        provider: retryContext.provider || row.provider || "vobiz",
      });
    } catch (err) {
      log.error(`❌ [dialerRetryEngine] Auto-redial failed for ${row.leadName} (org ${row.orgId}):`, err.message);
      // A hard failure (bad credentials, compliance block, no Vobiz number
      // configured) will fail identically every 5 minutes — mark it
      // exhausted instead of leaving it "pending" to be retried forever.
      await db.patch("calllogs", row.orgId, row.id, { retryStatus: "exhausted" }).catch(() => {});
    }
  }
}

// Queue job: places exactly one redial attempt. Never rethrows — see
// autoDialEngine.js's identical handlePlaceDialJob for why (a failed
// redial is a normal expected outcome the row's own retryStatus already
// tracks toward MAX_RETRY_ATTEMPTS; a queue-level rethrow-and-retry would
// just duplicate that with a different budget/backoff).
async function handlePlaceRedialJob(data) {
  const { orgId, rowId, dialTarget, leadName, baseUrl, attemptNumber, questions, from, language, assignedContact, retryPolicy, taskId, leadId, provider = "vobiz" } = data;
  try {
    const telephony = require("../telephony/registry");
    await telephony.triggerOutboundCall(provider, orgId, dialTarget, {
      baseUrl, attemptNumber, questions, from, language, assignedContact, retryPolicy, taskId, leadId,
    });
    await db.patch("calllogs", orgId, rowId, { retryStatus: "retried", retryClaimedAt: null });
  } catch (err) {
    log.error(`❌ [dialerRetryEngine] Redial placement failed for ${leadName} (org ${orgId}):`, err.message);
    const retryFields = db.computeRetryFields(attemptNumber);
    await db.patch("calllogs", orgId, rowId, retryFields).catch(() => {});
  }
}

let redialQueueRegistered = false;
function getRedialQueue() {
  return getQueue();
}

function registerDialerRetryWorker() {
  const queue = getQueue();
  if (!redialQueueRegistered) {
    queue.process("placeRedial", handlePlaceRedialJob, { concurrency: REDIAL_CONCURRENCY });
    redialQueueRegistered = true;
  }
}

module.exports = { processDueRetries, registerDialerRetryWorker };
