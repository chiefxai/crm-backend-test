// src/telephony/normalizer.js
// Provider-neutral telephony primitives. Provider folders translate their
// native API/WS/webhook shapes into these values; CRM code should consume the
// normalized values instead of branching on provider names.

const CALL_STATUSES = Object.freeze({
  RINGING: "ringing",
  ANSWERED: "answered",
  COMPLETED: "completed",
  NO_ANSWER: "no_answer",
  BUSY: "busy",
  FAILED: "failed",
  REJECTED: "rejected",
  MACHINE: "machine",
  UNKNOWN: "unknown",
});

const EVENT_TYPES = Object.freeze({
  INCOMING_CALL: "incoming_call",
  CALL_RINGING: "call_ringing",
  CALL_ANSWERED: "call_answered",
  CALL_HANGUP: "call_hangup",
  CALL_FAILED: "call_failed",
  RECORDING_READY: "recording_ready",
  DTMF: "dtmf",
  MEDIA_START: "media_start",
  MEDIA_STOP: "media_stop",
});

function normalizeCallStatus(status, context = {}) {
  const raw = String(status || "").trim().toLowerCase().replace(/[ _-]+/g, "");
  if (context.machineDetected || /machine|voicemail|fax/.test(raw)) return CALL_STATUSES.MACHINE;
  if (/ring|queued|initiated|trying|progress/.test(raw)) return CALL_STATUSES.RINGING;
  if (/answer|inprogress|connected|up/.test(raw)) return CALL_STATUSES.ANSWERED;
  if (/complete|hangup|ended|finished/.test(raw)) return CALL_STATUSES.COMPLETED;
  if (/noanswer|timeout|unanswered/.test(raw)) return CALL_STATUSES.NO_ANSWER;
  if (/busy/.test(raw)) return CALL_STATUSES.BUSY;
  if (/reject|declin/.test(raw)) return CALL_STATUSES.REJECTED;
  if (/fail|error|cancel/.test(raw)) return CALL_STATUSES.FAILED;
  return CALL_STATUSES.UNKNOWN;
}

function normalizeCallIdentity({ provider, providerCallId, callId, internalCallId, ...rest } = {}) {
  const normalizedProviderCallId = providerCallId ?? callId ?? rest.CallUUID ?? rest.CallSid ?? rest.request_uuid ?? rest.RequestUUID ?? null;
  return {
    callId: internalCallId ?? rest.internalCallId ?? null,
    provider: provider || null,
    providerCallId: normalizedProviderCallId == null ? null : String(normalizedProviderCallId),
  };
}

function normalizeWebhookEvent({ provider, type, status, providerCallId, callId, from, to, recordingUrl, duration, metadata = {}, ...rest } = {}) {
  return {
    type: type || EVENT_TYPES.CALL_HANGUP,
    provider: provider || null,
    identity: normalizeCallIdentity({ provider, providerCallId, callId, internalCallId: rest.internalCallId, ...rest }),
    status: normalizeCallStatus(status, rest),
    from: from ?? rest.From ?? rest.fromNumber ?? null,
    to: to ?? rest.To ?? rest.toNumber ?? null,
    recordingUrl: recordingUrl ?? rest.recordingUrl ?? null,
    duration: duration == null ? null : Number(duration) || 0,
    metadata,
  };
}

function normalizeAudio({ pcm, sampleRate = 16000, channels = 1, encoding = "pcm_s16le" } = {}) {
  if (!Buffer.isBuffer(pcm)) throw new TypeError("normalized audio requires a Buffer");
  return { pcm, sampleRate, channels, encoding };
}

function normalizeRecording({ provider, providerRecordingId, url, contentType = "audio/wav", duration = null, metadata = {} } = {}) {
  return {
    provider: provider || null,
    providerRecordingId: providerRecordingId == null ? null : String(providerRecordingId),
    url: url || null,
    contentType,
    duration: duration == null ? null : Number(duration) || 0,
    metadata,
  };
}

module.exports = {
  CALL_STATUSES,
  EVENT_TYPES,
  normalizeCallStatus,
  normalizeCallIdentity,
  normalizeWebhookEvent,
  normalizeAudio,
  normalizeRecording,
};
