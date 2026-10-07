"use strict";

const { Queue, Worker } = require("bullmq");
const { getLogger } = require("../../observability/logger");
const db = require("../../db/repository");
const { processDueRetries } = require("../../crm/dialerRetryEngine");

const log = getLogger("scheduler.providers.bullmq");
const QUEUE_NAME = process.env.CALLBACK_SCHEDULER_QUEUE || "crm-callback-scheduler";
const RECONCILE_SCHEDULER_ID = "crm-callback-reconciler";
const RECONCILE_EVERY_MS = Math.max(
  10_000,
  Number(process.env.CALLBACK_SCHEDULER_RECONCILE_MS || 60_000)
);
const MAX_SCHEDULE_AHEAD = Math.max(
  100,
  Number(process.env.CALLBACK_SCHEDULER_MAX_BATCH || 5000)
);

function redisConnection() {
  return {
    host: process.env.REDIS_HOST || "redis",
    port: Number(process.env.REDIS_PORT || 6379),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
    maxRetriesPerRequest: null,
  };
}

function callbackJobId(row) {
  const dueAt = new Date(row.nextRetryAt).getTime();
  // Version the wake-up key so callbacks whose previous one-shot job was
  // consumed during a transient queue outage can be scheduled again after a deploy.
  return `callback-v2-${row.id}-${dueAt}`;
}

async function schedulePendingCallbacks(queue) {
  const now = Date.now();
  let cursor = null;
  let found = 0;
  let scheduled = 0;

  do {
    const page = await db.getPendingRetriesForScheduler(MAX_SCHEDULE_AHEAD, cursor);
    const rows = page.rows || [];
    found += rows.length;
    const jobs = [];
    for (const row of rows) {
      const dueAt = new Date(row.nextRetryAt).getTime();
      if (!row.id || !Number.isFinite(dueAt)) continue;
      jobs.push({
        name: "callback-due",
        data: { callLogId: row.id, scheduledFor: new Date(dueAt).toISOString() },
        opts: {
          jobId: callbackJobId(row),
          delay: Math.max(0, dueAt - now),
          attempts: 5,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      });
    }
    if (jobs.length) {
      await queue.addBulk(jobs);
      scheduled += jobs.length;
    }

    const nextCursor = page.nextCursor || null;
    if (nextCursor && cursor && nextCursor.nextRetryAt === cursor.nextRetryAt && nextCursor.id === cursor.id) {
      throw new Error("Callback scheduler pagination did not advance");
    }
    cursor = nextCursor;
  }
  while (cursor);

  return { found, scheduled };
}

function createBullMqCallbackScheduler() {
  let queue = null;
  let worker = null;
  let started = false;

  async function start() {
    if (started) return;
    await db.ready;

    const connection = redisConnection();

    queue = new Queue(QUEUE_NAME, {
      connection,
      prefix: process.env.CALLBACK_SCHEDULER_REDIS_PREFIX || "crm",
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });

    worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        if (job.name === "callback-reconcile") {
          const result = await schedulePendingCallbacks(queue);
          log.info(`🔄 [bullmq] callback reconciliation: found=${result.found}, scheduled=${result.scheduled}`);
          return result;
        }

        if (job.name === "callback-due") {
          // The DB remains the source of truth. A delayed BullMQ job only
          // wakes the durable retry engine; claimCallForRetry() decides
          // whether this exact callback is still eligible.
          await processDueRetries(job.data?.callLogId || null);
          return { callLogId: job.data?.callLogId || null };
        }

        throw new Error(`Unknown callback scheduler job: ${job.name}`);
      },
      {
        connection,
        prefix: process.env.CALLBACK_SCHEDULER_REDIS_PREFIX || "crm",
        concurrency: Number(process.env.CALLBACK_SCHEDULER_CONCURRENCY || 1),
        maxStalledCount: 2,
      }
    );

    worker.on("completed", (job) => {
      log.debug?.(`[bullmq] completed ${job.name} ${job.id}`);
    });
    worker.on("failed", (job, err) => {
      log.error(`❌ [bullmq] job ${job?.name || "unknown"} ${job?.id || "unknown"} failed: ${err.message}`);
    });
    worker.on("error", (err) => {
      log.error(`❌ [bullmq] worker error: ${err.message}`);
    });

    await queue.waitUntilReady();
    await worker.waitUntilReady();

    await queue.upsertJobScheduler(
      RECONCILE_SCHEDULER_ID,
      { every: RECONCILE_EVERY_MS },
      {
        name: "callback-reconcile",
        data: { source: "bullmq-job-scheduler" },
        opts: {
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      }
    );

    // Recover immediately on boot instead of waiting for the first scheduler
    // tick. Future callback rows are still discovered every minute, while
    // BullMQ stores the actual delayed execution wake-up in Redis.
    const initial = await schedulePendingCallbacks(queue);
    log.info(
      `✅ Durable BullMQ callback scheduler started: queue=${QUEUE_NAME}, reconcileEveryMs=${RECONCILE_EVERY_MS}, initialFound=${initial.found}, initialScheduled=${initial.scheduled}`
    );

    started = true;
  }

  async function stop() {
    if (!started && !worker && !queue) return;
    started = false;
    try { await worker?.close(); } catch (err) { log.error(`BullMQ worker shutdown failed: ${err.message}`); }
    try { await queue?.close(); } catch (err) { log.error(`BullMQ queue shutdown failed: ${err.message}`); }
    worker = null;
    queue = null;
  }

  return {
    provider: "bullmq",
    start,
    stop,
    schedulePendingCallbacks: () => {
      if (!queue) throw new Error("BullMQ callback scheduler is not started");
      return schedulePendingCallbacks(queue);
    },
  };
}

module.exports = { createBullMqCallbackScheduler };
