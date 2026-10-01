const { getLogger } = require("../../observability/logger");
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_FRAME_BYTES = 640;
const DEFAULT_PREBUFFER_BYTES = 1280;
const DEFAULT_MAX_QUEUE_BYTES = 640_000;
function normalizePcmFrame(pcm, { sampleRate = DEFAULT_SAMPLE_RATE, channels = DEFAULT_CHANNELS, encoding = "pcm_s16le" } = {}) {
  if (!Buffer.isBuffer(pcm)) pcm = Buffer.from(pcm || []);
  return { pcm, sampleRate, channels, encoding };
}
function createOutboundAudioPlayer({ sendFrame, sampleRate = DEFAULT_SAMPLE_RATE, frameBytes = DEFAULT_FRAME_BYTES, prebufferBytes = DEFAULT_PREBUFFER_BYTES, maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES, intervalMs = 20, writeRecording, callId = "unknown", loggerName = "telephony.audio" } = {}) {
  if (typeof sendFrame !== "function") throw new TypeError("sendFrame is required");
  const log = getLogger(loggerName);
  let outboundQueue = Buffer.alloc(0), intervalId = null, hasPrebuffered = false, skipPrebufferOnce = false, fillerPlaying = false;\n  // Provider-agnostic generation guard. Providers can invalidate the current\n  // spoken generation on barge-in/reconnect/new turn; stale audio is then\n  // rejected before it ever reaches the transport queue.\n  let activeGeneration = 0;
  let recordOutbound = typeof writeRecording === "function" ? writeRecording : null;
  const audioStats = { chunksIn: 0, bytesIn: 0, framesSent: 0, lastLogAt: 0, lastSendAt: 0, maxGapMs: 0 };
  const startPacing = () => {
    if (intervalId) return;
    intervalId = setInterval(() => {
      if (!hasPrebuffered) { const minBytes = skipPrebufferOnce ? frameBytes : prebufferBytes; if (outboundQueue.length < minBytes) return; hasPrebuffered = true; skipPrebufferOnce = false; }
      if (outboundQueue.length < frameBytes) return;
      const chunk = outboundQueue.subarray(0, frameBytes);
      let sent = false;
      try { sent = sendFrame(chunk, { sampleRate, channels: 1, encoding: "pcm_s16le" }) !== false; } catch (err) { log.warn("Audio frame send failed [" + callId + "]: " + err.message); }
      if (!sent) return;
      outboundQueue = outboundQueue.subarray(frameBytes);
      const now = Date.now();
      if (audioStats.lastSendAt) audioStats.maxGapMs = Math.max(audioStats.maxGapMs, now - audioStats.lastSendAt);
      audioStats.lastSendAt = now; audioStats.framesSent++;
      if (now - audioStats.lastLogAt >= 1000) { log.debug("Audio pacer [" + callId + "]: queue " + outboundQueue.length + "B, frames " + audioStats.framesSent + ", max gap " + audioStats.maxGapMs + "ms"); audioStats.framesSent = 0; audioStats.maxGapMs = 0; audioStats.lastLogAt = now; }
    }, intervalMs);
  };
  const stopPacing = () => { if (intervalId) clearInterval(intervalId); intervalId = null; outboundQueue = Buffer.alloc(0); hasPrebuffered = false; skipPrebufferOnce = false; };
  return {
    PREBUFFER_BYTES: prebufferBytes,
    setWriteRecording(fn) { recordOutbound = typeof fn === "function" ? fn : null; },
    enqueuePcm(pcm16k, { fastStart = false } = {}) {
      if (!pcm16k?.length) return;
      const normalized = normalizePcmFrame(pcm16k, { sampleRate });
      audioStats.chunksIn++; audioStats.bytesIn += normalized.pcm.length;
      outboundQueue = outboundQueue.length ? Buffer.concat([outboundQueue, normalized.pcm]) : normalized.pcm;
      if (outboundQueue.length > maxQueueBytes) { outboundQueue = outboundQueue.subarray(outboundQueue.length - maxQueueBytes); hasPrebuffered = true; log.warn("Audio queue capped [" + callId + "] at " + maxQueueBytes + "B"); }
      if (fastStart && !hasPrebuffered) skipPrebufferOnce = true;
      if (recordOutbound) recordOutbound(normalized.pcm);
      startPacing();
    },
    clearQueue() { outboundQueue = Buffer.alloc(0); hasPrebuffered = false; skipPrebufferOnce = false; fillerPlaying = false; },\n    beginGeneration() {\n      activeGeneration += 1;\n      outboundQueue = Buffer.alloc(0);\n      hasPrebuffered = false;\n      skipPrebufferOnce = false;\n      fillerPlaying = false;\n      return activeGeneration;\n    },\n    getGeneration: () => activeGeneration,
    stopPacing, startPacing,
    isFillerPlaying: () => fillerPlaying,
    setFillerPlaying(value) { fillerPlaying = Boolean(value); },
    getQueueLength: () => outboundQueue.length,
    getStats: () => ({ ...audioStats, queueBytes: outboundQueue.length }),
  };
}
module.exports = { DEFAULT_SAMPLE_RATE, DEFAULT_CHANNELS, DEFAULT_FRAME_BYTES, DEFAULT_PREBUFFER_BYTES, normalizePcmFrame, createOutboundAudioPlayer };