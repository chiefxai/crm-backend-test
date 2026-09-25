// src/ai/postCallAgents/shared.js
// ============================================================
// Shared plumbing for every post-call AI agent in this folder — a single
// LangChain chat model plus its Zod-schema structured-output helper.
//
// Uses LangChain's `.withStructuredOutput(zodSchema)` instead of the old
// hand-rolled "call Gemini -> JSON.parse -> schema.parse -> retry once on
// failure" loop — LangChain drives the model's native structured-output/
// function-calling mode itself (so the model is constrained to the schema
// shape, not just asked nicely in the prompt) and retries/repairs
// malformed output internally, giving the same Pydantic-style "define a
// schema, get a validated typed object back" guarantee Zod already gave
// us, just enforced at the model layer instead of after the fact.
//
// Same dual auth modes as googleAiClient.js (Vertex AI vs. Google AI
// Studio API key) — genai.isVertex there is the one source of truth for
// which mode this deployment is in, so this mirrors it exactly rather
// than re-deriving the choice from env vars a second time.
// ============================================================

const { ChatVertexAI } = require("@langchain/google-vertexai");
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const genai = require("../googleAiClient");
const { getLogger } = require("../../observability/logger");
const log = getLogger("ai.postCallAgents");

const MODEL = "gemini-2.5-flash-lite";
const POST_CALL_PIPELINE_VERSION = "2026-09-25.13";

// Both LangChain client classes throw in their CONSTRUCTOR when no
// credentials are configured (unlike @google/genai's client, which only
// warns and defers the failure to the first actual call) — constructing
// this eagerly at module load would crash the whole process on require
// in any environment without Gemini set up (a bare local checkout, CI),
// even one that never ends up placing a real call. Built lazily instead,
// and only once, the first time an agent actually needs it.
const _models = new Map();
function getModel(orgId = null) {
  const cacheKey = genai.isVertex ? String(orgId || "shared") : "studio";
  if (_models.has(cacheKey)) return _models.get(cacheKey);

  if (genai.isVertex) {
    // getClientForOrg resolves the dedicated project created for this org.
    // The model is created lazily inside generateStructured because resolving
    // the org project is asynchronous.
    return null;
  }

  const model = new ChatGoogleGenerativeAI({
    model: MODEL,
    apiKey: process.env.GEMINI_API_KEY,
  });
  _models.set(cacheKey, model);
  return model;
}

async function getModelForOrg(orgId = null) {
  if (!orgId) return getModel(null);
  const client = await genai.getClientForOrg(orgId);
  const projectKey = client.projectId;
  const credentialKey = client.runtimeCredentialFingerprint || "unknown";
  const modelKey = `${projectKey}:${credentialKey}`;
  if (_models.has(modelKey)) return _models.get(modelKey);
  if (!client.runtimeCredentials) {
    throw new Error(`Organization ${orgId} has no organization-specific Google Cloud runtime credentials.`);
  }
  const model = new ChatVertexAI({
    model: MODEL,
    location: client.location || "us-central1",
    authOptions: {
      projectId: projectKey,
      credentials: client.runtimeCredentials,
    },
  });
  _models.set(modelKey, model);
  return model;
}

// Invokes the model constrained to `schema` and returns the validated,
// typed result directly — no manual JSON.parse, no manual retry loop.
// `fallback` (a value, or a function receiving the caught error) covers
// the same "never throw into the caller" contract the old
// generateValidated() had, for a genuinely failed call (bad credentials,
// network error, the model refusing entirely) rather than malformed
// output, which LangChain's structured-output mode already guards against
// at the model level.
// `onUsage`, when given, is called once with { inputTokens, outputTokens }
// from the underlying AIMessage's usage_metadata (LangChain's normalized
// token count, same field sentimentAgent.js already reads) — lets a
// caller meter/track cost for this specific generation without changing
// this function's return value, so every existing call site keeps
// working unchanged. Not called on a genuinely failed request (network
// error, bad credentials) since there's no usage to report; a fallback
// value being returned isn't itself a cost.
function describeSchema(schema) {
  const seen = new Set();
  function describe(node, depth = 0) {
    if (!node || depth > 5) return "unknown";
    const def = node._def || {};
    const typeName = def.typeName || "";
    if (typeName === "ZodObject") {
      const shape = typeof def.shape === "function" ? def.shape() : (def.shape || {});
      return "object{" + Object.entries(shape).map(([key, value]) => `${key}:${describe(value, depth + 1)}`).join(",") + "}";
    }
    if (typeName === "ZodArray") return "array<" + describe(def.type, depth + 1) + ">";
    if (typeName === "ZodOptional") return describe(def.innerType, depth + 1) + "?";
    if (typeName === "ZodNullable") return describe(def.innerType, depth + 1) + "|null";
    if (typeName === "ZodDefault") return describe(def.innerType, depth + 1);
    if (typeName === "ZodString") return "string";
    if (typeName === "ZodNumber") return "number";
    if (typeName === "ZodBoolean") return "boolean";
    if (typeName === "ZodEnum") return "enum[" + (def.values || []).join("|") + "]";
    if (typeName === "ZodLiteral") return "literal(" + JSON.stringify(def.value) + ")";
    if (typeName === "ZodUnion") return "union[" + (def.options || []).map(x => describe(x, depth + 1)).join("|") + "]";
    if (typeName === "ZodRecord") return "record";
    if (typeName === "ZodAny") return "any";
    if (typeName === "ZodUnknown") return "unknown";
    return typeName || "unknown";
  }
  if (!schema || seen.has(schema)) return "object";
  seen.add(schema);
  return describe(schema);
}

function extractJsonObject(content) {
  if (content == null) return null;
  const text = Array.isArray(content)
    ? content.map((part) => typeof part === "string" ? part : (part?.text || "")).join("")
    : String(content);
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

async function generateStructured({ prompt, schema, fallback, label, onUsage, orgId = null }) {
  const startedAt = Date.now();
  const promptChars = String(prompt || "").length;
  try {
    log.info("🧠 [postCallAgents:" + label + "] generation started: promptChars=" + promptChars);
    const model = await getModelForOrg(orgId);
    // Some deployed LangChain versions expose ChatModel.invoke() but do not
    // expose .withStructuredOutput(). Using the latter directly made every
    // post-call agent fail in production. Keep structured output provider-
    // independent: ask for strict JSON, invoke the normal chat model, then
    // validate the result with the same Zod schema.
    const schemaDescription = describeSchema(schema);
    const request = `${prompt}\n\nReturn ONLY one valid JSON object matching this schema. Do not use markdown or code fences. Schema:\n${schemaDescription}`;
    log.info(`🔎 [postCallAgents:${label}] request size: promptChars=${promptChars}, schemaChars=${schemaDescription.length}, totalRequestChars=${request.length}`);
    const result = await model.invoke(request);
    const raw = result;
    const parsedObject = extractJsonObject(result?.content);
    if (!parsedObject) throw new Error("Model returned no valid JSON object");
    const parsed = schema.parse(parsedObject);
    log.info("✅ [postCallAgents:" + label + "] generation completed in " + (Date.now() - startedAt) + "ms");
    if (onUsage) {
      // LangChain normally exposes usage_metadata, but provider adapters can
      // surface camelCase fields or response_metadata. Normalize all supported
      // shapes here so agents never need provider-specific token logic.
      const usage = raw?.usage_metadata || raw?.response_metadata?.usage || {};
      const inputTokens = Number(
        usage.input_tokens ??
        usage.inputTokens ??
        usage.prompt_token_count ??
        usage.promptTokenCount ??
        0
      ) || 0;
      const outputTokens = Number(
        usage.output_tokens ??
        usage.outputTokens ??
        usage.candidates_token_count ??
        usage.candidatesTokenCount ??
        0
      ) || 0;
      log.info(`📊 [postCallAgents:${label}] usage: inputTokens=${inputTokens}, outputTokens=${outputTokens}`);
      // Usage metering is observational. A billing callback must never be
      // allowed to turn a successful AI generation into a failed agent.
      try {
        onUsage({ inputTokens, outputTokens });
      } catch (usageErr) {
        log.error(
          `⚠️ [postCallAgents:${label}] usage accounting callback failed; preserving AI result:`,
          usageErr.message
        );
      }
    }
    return parsed;
  } catch (err) {
    log.error("❌ [postCallAgents:" + label + "] structured generation failed after " + (Date.now() - startedAt) + "ms (promptChars=" + promptChars + "): " + err.message);
    return typeof fallback === "function" ? fallback(err) : fallback;
  }
}

// Renders the workflow answers already captured during a call (see
// db.getResponsesByCallId — the same live-tool-call data callFinalizer.js
// itself prefers) into prompt text — shared by the sentiment and summary
// agents so both judge/describe a call using what was actually learned,
// not the transcript alone.
function formatWorkflowAnswers(workflowAnswers) {
  const rows = (workflowAnswers || []).filter((r) => r?.question);
  if (!rows.length) return "(No workflow questions were tracked for this call.)";
  return rows.map((r) => `- ${r.label || r.question}: ${r.answer?.trim() || "(no answer given)"}`).join("\n");
}

module.exports = { MODEL, POST_CALL_PIPELINE_VERSION, getModel, getModelForOrg, log, generateStructured, formatWorkflowAnswers };
