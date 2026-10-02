const fs = require("fs");
const path = require("path");

const RECORDING_MODES = Object.freeze({
  AUTO: "auto",
  PROVIDER: "provider",
  PLATFORM: "platform",
  DISABLED: "disabled",
});

function normalizeMode(value) {
  const mode = String(value || RECORDING_MODES.AUTO).trim().toLowerCase();
  return Object.values(RECORDING_MODES).includes(mode) ? mode : RECORDING_MODES.AUTO;
}

function createCallRecorder({
  provider,
  callId,
  orgId = null,
  mode = RECORDING_MODES.AUTO,
  providerAdapter = null,
  uploadPlatformRecording,
  tempDir = path.join(__dirname, "../../../temp"),
  logger = console,
} = {}) {
  const requestedMode = normalizeMode(mode);
  let activeMode = requestedMode;
  let providerRecording = null;
  let platformPath = null;
  let stream = null;
  let streamClosed = false;
  let finalized = false;
  const log = logger || console;

  function providerCanRecord() {
    return !!(
      providerAdapter &&
      typeof providerAdapter.startRecording === "function" &&
      typeof providerAdapter.stopRecording === "function"
    );
  }

  function openPlatformRecorder() {
    if (stream || platformPath) return;
    fs.mkdirSync(tempDir, { recursive: true });
    platformPath = path.join(tempDir, String(callId) + ".pcm");
    stream = fs.createWriteStream(platformPath);
    stream.on("error", (err) => {
      streamClosed = true;
      if (log.error) log.error("[recording] platform stream error [" + callId + "]: " + err.message);
    });
    stream.on("finish", () => { streamClosed = true; });
    activeMode = RECORDING_MODES.PLATFORM;
  }

  async function start() {
    if (finalized || requestedMode === RECORDING_MODES.DISABLED) {
      activeMode = RECORDING_MODES.DISABLED;
      return;
    }

    if ((requestedMode === RECORDING_MODES.PROVIDER || requestedMode === RECORDING_MODES.AUTO) && providerCanRecord()) {
      try {
        providerRecording = await providerAdapter.startRecording({ callId, orgId });
        if (providerRecording) {
          activeMode = RECORDING_MODES.PROVIDER;
          if (log.info) log.info("[recording] provider recording started [" + callId + "]");
          return;
        }
      } catch (err) {
        if (requestedMode === RECORDING_MODES.PROVIDER) throw err;
        if (log.warn) log.warn("[recording] provider recording unavailable; falling back to platform [" + callId + "]: " + err.message);
      }
    } else if (requestedMode === RECORDING_MODES.PROVIDER) {
      throw new Error('Telephony provider "' + provider + '" does not implement provider recording');
    }

    openPlatformRecorder();
  }

  function write(buffer) {
    if (finalized || activeMode === RECORDING_MODES.DISABLED || !buffer || !buffer.length) return false;
    if (activeMode !== RECORDING_MODES.PLATFORM) return true;
    if (!stream) openPlatformRecorder();
    if (streamClosed || stream.destroyed || stream.writableEnded) return false;
    try {
      return stream.write(buffer);
    } catch (err) {
      streamClosed = true;
      if (log.error) log.error("[recording] platform write failed [" + callId + "]: " + err.message);
      return false;
    }
  }

  async function finalize() {
    if (finalized) return null;
    finalized = true;

    if (activeMode === RECORDING_MODES.DISABLED) {
      return { url: null, source: "disabled", recordingId: null };
    }

    if (activeMode === RECORDING_MODES.PROVIDER) {
      try {
        const result = await providerAdapter.stopRecording({ callId, orgId, recording: providerRecording });
        const recording = result || providerRecording || {};
        return {
          url: recording.url || recording.recordingUrl || null,
          source: "provider",
          recordingId: recording.id || recording.recordingId || null,
          provider,
          duration: recording.duration || recording.recordingDuration || null,
        };
      } catch (err) {
        if (log.error) log.error("[recording] provider finalization failed [" + callId + "]: " + err.message);
        return { url: null, source: "provider", recordingId: null, error: err.message };
      }
    }

    if (!platformPath) return { url: null, source: "platform", recordingId: null };

    if (stream && !streamClosed && !stream.destroyed && !stream.writableEnded) {
      try { stream.end(); } catch {}
    }

    if (stream && !streamClosed) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        stream.once("finish", () => { clearTimeout(timer); resolve(); });
      });
    }

    if (!fs.existsSync(platformPath)) return { url: null, source: "platform", recordingId: null };

    try {
      const rawPcm = fs.readFileSync(platformPath);
      if (!rawPcm.length || typeof uploadPlatformRecording !== "function") {
        return { url: null, source: "platform", recordingId: null };
      }
      const wavBuffer = Buffer.concat([createWavHeader(rawPcm.length), rawPcm]);
      const url = await uploadPlatformRecording(wavBuffer, callId);
      return { url: url || null, source: "platform", recordingId: null };
    } finally {
      try { fs.unlinkSync(platformPath); } catch {}
    }
  }

  return {
    start,
    write,
    finalize,
    getMode: () => activeMode,
    getRequestedMode: () => requestedMode,
    getProviderRecording: () => providerRecording,
    getPath: () => platformPath,
  };
}

function createWavHeader(dataLength, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

module.exports = { RECORDING_MODES, normalizeMode, createCallRecorder, createWavHeader };
