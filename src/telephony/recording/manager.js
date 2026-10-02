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

  // Platform recordings are captured as two independent 16 kHz mono tracks.
  // They are mixed only after the call ends. Writing both directions into one
  // byte stream was the source of the audible recording flicker: caller and
  // agent audio arrived on different timelines and were being concatenated.
  const tracks = {
    caller: [],
    agent: [],
  };
  const nextSampleByTrack = {
    caller: 0,
    agent: 0,
  };
  const recordingStartedAt = process.hrtime.bigint();

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
    // Keep the legacy path only as a marker. Actual audio is held per track
    // until finalize so it can be timestamp-aligned and mixed correctly.
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

  function write(buffer, options = {}) {
    if (finalized || activeMode === RECORDING_MODES.DISABLED || !buffer || !buffer.length) return false;
    if (activeMode !== RECORDING_MODES.PLATFORM) return true;

    const track = options?.track === "caller" ? "caller" : "agent";
    const pcm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!pcm.length) return false;

    // The live media transport is frame-based (Vobiz uses 20 ms frames).
    // WebSocket delivery is allowed to bunch several frames together, so
    // wall-clock arrival time MUST NOT determine where a frame belongs in
    // the recording. If three 20 ms frames arrive in one event-loop tick,
    // their arrival timestamps can be almost identical and the old recorder
    // placed them on top of each other, producing the "many voices",
    // flickering/garbled playback seen in recordings.
    //
    // Use arrival time only to preserve genuine silence/gaps, but never allow
    // it to move a frame backwards or overlap the previous frame on the same
    // track. The frame duration is the authoritative minimum cursor advance.
    const elapsedNs = process.hrtime.bigint() - recordingStartedAt;
    const elapsedSamples = Math.max(0, Number(elapsedNs / 1000000n) * 16);
    const frameSamples = Math.floor(pcm.length / 2);
    const offsetSamples = Math.max(elapsedSamples, nextSampleByTrack[track]);
    nextSampleByTrack[track] = offsetSamples + frameSamples;

    tracks[track].push({ offsetSamples, pcm: Buffer.from(pcm) });
    return true;
  }

  function buildMixedPcm() {
    const all = [...tracks.caller, ...tracks.agent];
    if (!all.length) return Buffer.alloc(0);

    const endSample = all.reduce(
      (max, item) => Math.max(max, item.offsetSamples + Math.floor(item.pcm.length / 2)),
      0,
    );
    const mixed = new Float32Array(endSample);
    const contributors = new Uint8Array(endSample);

    for (const item of all) {
      const samples = new Int16Array(
        item.pcm.buffer,
        item.pcm.byteOffset,
        Math.floor(item.pcm.byteLength / 2),
      );
      for (let i = 0; i < samples.length; i++) {
        const index = item.offsetSamples + i;
        if (index >= mixed.length) break;
        mixed[index] += samples[i];
        if (contributors[index] < 255) contributors[index]++;
      }
    }

    const out = Buffer.alloc(mixed.length * 2);
    for (let i = 0; i < mixed.length; i++) {
      // Average only the tracks that are actually present at this sample.
      // A single-sided inbound call therefore keeps full volume instead of
      // being unnecessarily attenuated, while overlapping caller/agent
      // speech cannot clip the 16-bit output.
      const count = contributors[i] || 1;
      const sample = Math.max(-32768, Math.min(32767, Math.round(mixed[i] / count)));
      out.writeInt16LE(sample, i * 2);
    }
    return out;
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

    const rawPcm = buildMixedPcm();
    if (!rawPcm.length || typeof uploadPlatformRecording !== "function") {
      return { url: null, source: "platform", recordingId: null };
    }

    try {
      const wavBuffer = Buffer.concat([createWavHeader(rawPcm.length), rawPcm]);
      const url = await uploadPlatformRecording(wavBuffer, callId);
      return { url: url || null, source: "platform", recordingId: null };
    } finally {
      tracks.caller.length = 0;
      tracks.agent.length = 0;
      try { if (platformPath) fs.unlinkSync(platformPath); } catch {}
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
