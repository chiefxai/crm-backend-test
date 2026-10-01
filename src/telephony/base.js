// src/telephony/base.js — runtime contract for telephony providers
//
// Provider-specific transport, authentication, media framing and REST calls
// stay inside src/telephony/<provider>/. Shared CRM code consumes only the
// normalized primitives below.

const { normalizeCallStatus, normalizeCallIdentity, normalizeWebhookEvent, normalizeAudio, normalizeRecording } = require("./normalizer");

const REQUIRED = ["name", "wsPaths", "handleUpgrade", "getRouter"];

function validateConnector(connector) {
  const missing = REQUIRED.filter((key) => !connector || !connector[key]);
  if (missing.length) throw new Error(`[telephony/base] connector is missing: ${missing.join(", ")}`);
  if (!Array.isArray(connector.wsPaths)) throw new Error(`[telephony/base] ${connector.name}.wsPaths must be an array`);
  return connector;
}

function capabilitiesOf(connector) {
  return Object.freeze({
    inbound: false,
    outbound: typeof connector?.triggerOutboundCall === "function",
    streaming: Array.isArray(connector?.wsPaths) && connector.wsPaths.length > 0,
    recording: typeof connector?.normalizeRecording === "function" || connector?.capabilities?.recording === true,
    dtmf: connector?.capabilities?.dtmf === true,
    numberProvisioning: typeof connector?.provisionInboundNumber === "function" || connector?.capabilities?.numberProvisioning === true,
    machineDetection: connector?.capabilities?.machineDetection === true,
    ...connector?.capabilities,
  });
}

module.exports = {
  REQUIRED,
  validateConnector,
  capabilitiesOf,
  normalizeCallStatus,
  normalizeCallIdentity,
  normalizeWebhookEvent,
  normalizeAudio,
  normalizeRecording,
};
