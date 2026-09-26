const { getLogger } = require("../observability/logger");
const log = getLogger("telephony.vobizOutboundAudio");

const PREBUFFER_BYTES = 1280; // 40ms of 16kHz PCM16

function sendJson(wsConn, obj) {
  if (wsConn && wsConn.readyState === 1) wsConn.send(JSON.stringify(obj));
}

/**
 * Single outbound audio pacer per Vobiz media WebSocket — shared by prepared
 * opening greeting playback and Gemini Live streaming audio.
 */
function createVobizOutboundAudioPlayer(vobizWs, getStreamId, { writeRecording, callId = "unknown" } = {}) {
  let currentWs = vobizWs;
  let outboundQueue = Buffer.alloc(0);
  let intervalId = null;
  let hasPrebuffered = false;
  let skipPrebufferOnce = false;
  let fillerPlaying = false;
  const audioStats = { chunksIn: 0, bytesIn: 0, framesSent: 0, lastLogAt: 0, lastSendAt: 0, maxGapMs: 0 };

  const startPacing = () => {
    if (intervalId) return;
    intervalId = setInterval(() => {
      if (!hasPrebuffered) {
        const minBytes = skipPrebufferOnce ? 640 : PREBUFFER_BYTES;
        if (outboundQueue.length < minBytes) return;
        hasPrebuffered = true;
        skipPrebufferOnce = false;
      }
      if (outboundQueue.length >= 640) {
        if (!currentWs || currentWs.readyState !== 1) return;
        const chunk = outboundQueue.subarray(0, 640);
        outboundQueue = outboundQueue.subarray(640);
        sendJson(currentWs, {
          event: "playAudio",
          media: {
            contentType: "audio/x-l16",
            sampleRate: 16000,
            payload: chunk.toString("base64"),
          },
        });
        const now = Date.now();
        if (audioStats.lastSendAt) audioStats.maxGapMs = Math.max(audioStats.maxGapMs, now - audioStats.lastSendAt);
        audioStats.lastSendAt = now;
        audioStats.framesSent++;
        if (now - audioStats.lastLogAt >= 1000) {
          log.debug(`🔊 Vobiz audio pacer [${callId}]: queue ${outboundQueue.length}B, frames ${audioStats.framesSent}, max gap ${audioStats.maxGapMs}ms`);
          audioStats.framesSent = 0;
          audioStats.maxGapMs = 0;
          audioStats.lastLogAt = now;
        }
      }
    }, 20);
  };

  const stopPacing = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    outboundQueue = Buffer.alloc(0);
    hasPrebuffered = false;
    skipPrebufferOnce = false;
  };

  return {
    PREBUFFER_BYTES,
    setWebSocket(ws) {
      currentWs = ws;
    },
    enqueuePcm(pcm16k, { fastStart = false } = {}) {
      if (!pcm16k || !pcm16k.length) return;
      audioStats.chunksIn++;
      audioStats.bytesIn += pcm16k.length;
      const MAX_OUTBOUND_QUEUE_BYTES = 640_000;
      outboundQueue = outboundQueue.length ? Buffer.concat([outboundQueue, pcm16k]) : pcm16k;
      if (outboundQueue.length > MAX_OUTBOUND_QUEUE_BYTES) {
        outboundQueue = outboundQueue.subarray(outboundQueue.length - MAX_OUTBOUND_QUEUE_BYTES);
        hasPrebuffered = true;
        log.warn(`⚠️ Vobiz audio queue capped [${callId}] at ${MAX_OUTBOUND_QUEUE_BYTES}B`);
      }
      if (fastStart && !hasPrebuffered) skipPrebufferOnce = true;
      if (writeRecording) writeRecording(pcm16k);
      startPacing();
    },
    clearQueue() {
      outboundQueue = Buffer.alloc(0);
      hasPrebuffered = false;
      skipPrebufferOnce = false;
      fillerPlaying = false;
    },
    stopPacing,
    startPacing,
    isFillerPlaying: () => fillerPlaying,
    setFillerPlaying(value) {
      fillerPlaying = Boolean(value);
    },
    getQueueLength: () => outboundQueue.length,
  };
}

module.exports = { createVobizOutboundAudioPlayer, PREBUFFER_BYTES };
