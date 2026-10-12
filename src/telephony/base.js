// src/telephony/base.js — runtime contract for telephony providers
//
// Provider-specific transport, authentication, media framing and REST calls
// stay inside src/telephony/<provider>/. Shared CRM code consumes only the
// normalized primitives below.

const { normalizeCallStatus, normalizeCallIdentity, normalizeWebhookEvent, normalizeAudio, normalizeRecording } = require("./normalizer");

const REQUIRED = ["name", "wsPaths", "handleUpgrade", "getRouter"];

// Capabilities describe operations the shared telephony services may offer.
// Provider adapters can expose only the operations their API supports.
const CAPABILITY_DEFAULTS = Object.freeze({
  inbound: false,
  outbound: false,
  streaming: false,
  recording: false,
  dtmf: false,
  numberProvisioning: false,
  numberDiscovery: false,
  numberPurchase: false,
  manualNumberEntry: true,
  numberVerification: false,
  machineDetection: false,
  credentialValidation: false,
});

const CREDENTIAL_FIELD_TYPES = new Set(["text", "password", "secret", "url", "select"]);

function normalizeCredentialSchema(schema, providerName = "provider") {
  if (schema === undefined) return [];
  if (!Array.isArray(schema)) throw new Error(`[telephony/base] ${providerName}.credentialSchema must be an array`);
  return schema.map((field, index) => {
    if (!field || typeof field !== "object" || typeof field.key !== "string" || !field.key.trim()) {
      throw new Error(`[telephony/base] ${providerName}.credentialSchema[${index}] requires a key`);
    }
    const type = field.type || "password";
    if (!CREDENTIAL_FIELD_TYPES.has(type)) {
      throw new Error(`[telephony/base] ${providerName}.credentialSchema[${index}] has unsupported type`);
    }
    return Object.freeze({
      key: field.key,
      label: String(field.label || field.key),
      type,
      required: field.required !== false,
      ...(field.placeholder ? { placeholder: String(field.placeholder) } : {}),
      ...(Array.isArray(field.options) ? { options: field.options.map((option) => ({ value: String(option.value), label: String(option.label) })) } : {}),
    });
  });
}

function validateConnector(connector) {
  const missing = REQUIRED.filter((key) => !connector || !connector[key]);
  if (missing.length) throw new Error(`[telephony/base] connector is missing: ${missing.join(", ")}`);
  if (!Array.isArray(connector.wsPaths)) throw new Error(`[telephony/base] ${connector.name}.wsPaths must be an array`);
  if (connector.providerKey !== undefined && (typeof connector.providerKey !== "string" || !connector.providerKey.trim())) {
    throw new Error(`[telephony/base] ${connector.name}.providerKey must be a non-empty string`);
  }
  normalizeCredentialSchema(connector.credentialSchema, connector.name);
  return connector;
}

function capabilitiesOf(connector) {
  return Object.freeze({
    ...CAPABILITY_DEFAULTS,
    outbound: typeof connector?.triggerOutboundCall === "function",
    streaming: Array.isArray(connector?.wsPaths) && connector.wsPaths.length > 0,
    recording: typeof connector?.normalizeRecording === "function" || connector?.capabilities?.recording === true,
    dtmf: connector?.capabilities?.dtmf === true,
    numberProvisioning: typeof connector?.provisionInboundNumber === "function" || connector?.capabilities?.numberProvisioning === true,
    machineDetection: connector?.capabilities?.machineDetection === true,
    ...(connector?.capabilities || {}),
  });
}

function providerDefinitionOf(connector) {
  validateConnector(connector);
  return Object.freeze({
    providerKey: connector.providerKey || connector.name,
    name: connector.name,
    label: connector.label || connector.name,
    credentialSchema: Object.freeze(normalizeCredentialSchema(connector.credentialSchema, connector.name)),
    capabilities: capabilitiesOf(connector),
  });
}

module.exports = {
  REQUIRED,
  CAPABILITY_DEFAULTS,
  CREDENTIAL_FIELD_TYPES,
  validateConnector,
  capabilitiesOf,
  normalizeCredentialSchema,
  providerDefinitionOf,
  normalizeCallStatus,
  normalizeCallIdentity,
  normalizeWebhookEvent,
  normalizeAudio,
  normalizeRecording,
};
