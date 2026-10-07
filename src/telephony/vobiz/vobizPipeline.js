const { onScopedEvent, bindScopedCallbacks } = require("../../workspaces/scope");
// services/vobizPipeline.js
// ============================================================
// STT → LLM → TTS pipeline for real Vobiz phone calls, as an
// alternative to the audio-to-audio Gemini Live engine in
// vobizProxy.js. Selected via VOICE_ENGINE=pipeline (default).
//
// Reuses vobizProxy.js's exported call-state Maps (vobizCallNumbers/
// vobizCallOrgs/vobizCallDirection/vobizCallQuestions — populated by
// server.js's webhook routes) and its tool-call handlers / post-call
// processing, so org resolution, custom objects, knowledge base,
// email/WhatsApp sending, and call logging all behave identically to
// the audio-to-audio engine. Only the "how do we turn caller audio
// into agent audio" core is different — see geminiPipeline.js (the
// browser /session version) for the same three-stage design.
// ============================================================

const { getTimeOfDay } = require("../../lib/timeOfDay");
const fs = require("fs");
const path = require("path");
const ws = require("ws");
const { getConfig, getConfigForOrg, buildRuntimePrompt } = require("../../config/agentConfig");
const db = require("../../db/repository");
const objectsEngine = require("../../crm/objectsEngine");
const { buildCustomObjectTools, handleObjectToolCall } = require("../../utils/objectToolBuilder");
const knowledgeBase = require("../../ai/knowledgeBase");
const postCallAgents = require("../../ai/postCallAgents");
const questionnaire = require("../questionnaire");
const vobizProxy = require("./vobizProxy");
const { getLogger } = require("../../observability/logger");
const log = getLogger("telephony.vobizPipeline");
const {
  phoneCacheKey, vobizCallNumbers, vobizCallQuestions, vobizCallOrgs, vobizCallWorkspaces, vobizCallDirection, vobizPrewarmedClients,
  handleSearchPolicyKnowledgeBase, handleSaveQuestionResponse, handleSendEmailDocument,
  handleSendWhatsappMessage, handleSaveEnquiry, extractContactAndTrigger, hangupVobizCall, processPostCallData,
  resample24To16, appendCallLog,
} = vobizProxy;

const genai = require("../../ai/googleAiClient");

const VOICE_MAP = {
  Arjun: "Achird",
  Priya: "Sulafat",
  Dev:   "Sadaltager",
  Kavya: "Vindemiatrix",
};

const STT_MODEL = "gemini-live-2.5-flash-preview-native-audio-09-2025";
const LLM_MODEL = "gemini-2.5-flash";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

function sendJson(wsConn, obj) {
  if (wsConn.readyState === 1) wsConn.send(JSON.stringify(obj));
}

// Splits on sentence-ending punctuation so TTS can start on sentence 1
// while the LLM is still streaming sentence 2+.
function extractCompleteSentences(buffer) {
  const complete = [];
  const re = /[^.!?\n]+[.!?\n]+/g;
  let match;
  let lastIndex = 0;
  while ((match = re.exec(buffer)) !== null) {
    const sentence = match[0].trim();
    if (sentence) complete.push(sentence);
    lastIndex = re.lastIndex;
  }
  return { complete, rest: buffer.slice(lastIndex) };
}

// Legacy lending/insurance policy search tool — only added at runtime for
// orgs still on the hardcoded lending questionnaire path (no custom
// objects set up for their actual industry). See vobizProxy.js's identical
// comment for the full reasoning. Kept separate from BASE_TOOL_DECLARATIONS
// so it's not always handed to every org regardless of industry.
const LEGACY_INSURANCE_TOOL_DECLARATION = {
  name: "search_policy_knowledge_base",
  description: "Search the insurance policy documents database for definitions, policy terms, coverages, limits, and rules.",
  parameters: {
    type: "OBJECT",
    properties: { query: { type: "STRING", description: "Specific search terms or keywords to query in the insurance policy database" } },
    required: ["query"]
  }
};

const BASE_TOOL_DECLARATIONS = [
  {
    name: "save_question_response",
    description: "Record the client's answer to one of the mandatory questionnaire questions.",
    parameters: {
      type: "OBJECT",
      properties: {
        question: { type: "STRING", description: "The exact question asked to the client" },
        answer: { type: "STRING", description: "The client's answer, response, or statement" }
      },
      required: ["question", "answer"]
    }
  },
  {
    name: "send_email_document",
    description: "Send an email document to the user's Gmail ID. Use this when the user requests a copy of their document, loan package, or summary, and you have confirmed their Gmail ID.",
    parameters: {
      type: "OBJECT",
      properties: {
        recipient_email: { type: "STRING", description: "The recipient's email address (Gmail ID)" },
        subject: { type: "STRING", description: "The subject line of the email" },
        body: { type: "STRING", description: "The main body content of the email" },
        document_type: { type: "STRING", description: "The type of document being sent (e.g. 'policy brief', 'loan approval')" }
      },
      required: ["recipient_email", "subject", "body"]
    }
  },
  {
    name: "send_whatsapp_message",
    description: "Send a WhatsApp message or document link to the user. Use this when the user requests information or a file copy via WhatsApp, and you have confirmed their WhatsApp number.",
    parameters: {
      type: "OBJECT",
      properties: {
        whatsapp_number: { type: "STRING", description: "The target WhatsApp phone number (with country code)" },
        message: { type: "STRING", description: "The text message content to send" },
        document_url: { type: "STRING", description: "Optional URL of a document to attach" },
        file_name: { type: "STRING", description: "Optional name of the attached file" }
      },
      required: ["whatsapp_number", "message"]
    }
  },
];

async function handleVobizSession(vobizWs, streamContext = null) {
  const authorizedOrgId = streamContext?.orgId ? String(streamContext.orgId) : null;
  const authorizedCallId = streamContext?.callId ? String(streamContext.callId) : null;
  if (!authorizedOrgId || !authorizedCallId) throw new Error("Vobiz stream authorization context is required");
  let isActive = true;
  let streamId = null;
  let callId = null;
  const startTime = Date.now();

  const generatedCallId = `pcall_vobiz_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tempDir = path.join(__dirname, "../../../temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempPcmPath = path.join(tempDir, `${generatedCallId}.pcm`);
  const recordStream = fs.createWriteStream(tempPcmPath);
  const transcriptLines = [];
  const history = []; // [{role: "user"|"model", parts: [{text}]}]

  let activeConfig = getConfig();
  let voiceName = VOICE_MAP[activeConfig.activeVoice] || "Achird";

  // Generic last-resort fallback, used only if this org has no industry set
  // AND no questionnaire row saved yet (db.getQuestions() below already
  // returns this org's real industry-scoped defaults in every other case).
  const genericFallbackQuestions = [
    "Unga full name enna, sollunga?",
    "Ugaluku enna vishayathula help venum?",
    "Unga budget matum timeline enna?",
    "Ugaluku edhavadhu specific requirements iruka?"
  ];

  log.info(`📞 [pipeline] New Vobiz voice connection. Voice: ${activeConfig.activeVoice} (${voiceName})`);

  let liveInputTokens = 0, liveOutputTokens = 0;
  let totalInboundAudioBytes = 0, totalOutboundAudioBytes = 0;

  let isFinalized = false;
  let sttSession = null;
  let currentTurnBuffer = "";
  let turnBusy = false;
  let generation = 0;
  let resolvedOrgId = null;
  let toolDeclarations = BASE_TOOL_DECLARATIONS;
  let customObjects = [];
  let systemPrompt = "";
  let getCallerNumber = () => "Vobiz Call";

  const contactState = { email: null, phone: null, emailPending: false, whatsAppPending: false };

  const outboundQueue = [];
  let pacingInterval = null;
  const startPacing = () => {
    if (pacingInterval) return;
    pacingInterval = setInterval(() => {
      if (outboundQueue.length >= 640) {
        const chunk = Buffer.from(outboundQueue.splice(0, 640));
        sendJson(vobizWs, { event: "playAudio", media: { contentType: "audio/x-l16", sampleRate: 16000, payload: chunk.toString("base64") } });
      }
    }, 20);
  };
  const stopPacing = () => {
    if (pacingInterval) { clearInterval(pacingInterval); pacingInterval = null; }
    outboundQueue.length = 0;
  };

  let aiClient = null;
  let sessionReady = false;
  let sessionReadyResolve;
  const sessionReadyPromise = new Promise(res => { sessionReadyResolve = res; });

  onScopedEvent(vobizWs, "message", async (rawMsg) => {
    if (!isActive) return;
    const rawStr = rawMsg.toString();
    let msg;
    try { msg = JSON.parse(rawStr); }
    catch (_) { log.warn("⚠️ [pipeline] Vobiz sent non-JSON message:", rawStr.slice(0, 200)); return; }

    try {
      switch (msg.event) {
        case "start": {
          streamId = msg.start.streamId;
          callId = msg.start.callId;
          if (String(callId) !== authorizedCallId) {
            log.error(`🚫 [pipeline] Vobiz call authorization mismatch: token=${authorizedCallId} start=${callId}`);
            isActive = false;
            try { vobizWs.close(1008, "Call authorization mismatch"); } catch {}
            return;
          }
          const cachedOrgId = vobizCallOrgs.get(callId);
          if ((cachedOrgId && String(cachedOrgId) !== authorizedOrgId) || (vobizCallWorkspaces.has(callId) && vobizCallWorkspaces.get(callId) !== (streamContext.workspaceId || authorizedOrgId))) {
            log.error(`🚫 [pipeline] Vobiz org authorization mismatch: token=${authorizedOrgId} cache=${cachedOrgId}`);
            isActive = false;
            try { vobizWs.close(1008, "Organization authorization mismatch"); } catch {}
            return;
          }
          vobizCallOrgs.set(callId, authorizedOrgId);
          vobizCallWorkspaces.set(callId, streamContext.workspaceId || authorizedOrgId);
          log.info(`🚀 [pipeline] Vobiz Stream started: ${streamId} | CallId: ${callId} | Org: ${authorizedOrgId}`);

          const resolvedPhone = vobizCallNumbers.get(callId) || "";
          const sanitizedPhone = resolvedPhone.replace(/[\s\-\(\)\+]+/g, "");
          const customQuestions = sanitizedPhone ? vobizCallQuestions.get(phoneCacheKey(sanitizedPhone)) : null;
          getCallerNumber = () => resolvedPhone || "Vobiz Call";

          resolvedOrgId = authorizedOrgId;

          const startupStartTime = Date.now();

          // Outbound auto-dial calls know the org while the phone is ringing.
          // Reuse the Vertex client warmed by triggerVobizOutboundCall instead
          // of resolving the project + decrypting credentials after answer.
          const prewarmedClientPromise = vobizPrewarmedClients.get(callId);
          vobizPrewarmedClients.delete(callId);
          const clientPromise = prewarmedClientPromise || genai.getClientForOrg(resolvedOrgId);

          // These lookups are independent. Start them together immediately
          // while the tenant client is being resolved.
          let orgHasKnowledgeBase = false;
          const customObjectsPromise = objectsEngine.listObjects(resolvedOrgId).catch((err) => {
            log.error("❌ [pipeline] Failed to load custom objects:", err.message);
            return [];
          });
          const configPromise = getConfigForOrg(resolvedOrgId).catch((err) => {
            log.error("❌ [pipeline] Failed to load org config:", err.message);
            return activeConfig;
          });
          const knowledgeBasePromise = knowledgeBase.hasContent(resolvedOrgId).catch((err) => {
            log.error("❌ [pipeline] Failed to check knowledge base:", err.message);
            return false;
          });
          const questionsPromise = db.getQuestions(resolvedOrgId).catch((err) => {
            log.error("❌ [pipeline] Failed to load org questionnaire, using generic defaults:", err.message);
            return genericFallbackQuestions;
          });

          // STT does not depend on the business prompt. Once the client is
          // available, start its WebSocket handshake immediately; the DB/KB
          // lookups above are already running in parallel.
          aiClient = await clientPromise;
          if (!aiClient) aiClient = await genai.getClientForOrg(resolvedOrgId);
          log.info(`⏱️ [pipeline] Answer -> tenant Gemini client ready: ${Date.now() - startupStartTime}ms`);
          const sttReadyPromise = openSttSession();

          [customObjects, activeConfig, orgHasKnowledgeBase] = await Promise.all([
            customObjectsPromise,
            configPromise,
            knowledgeBasePromise,
          ]);
          const questionsList = await questionsPromise;
          voiceName = VOICE_MAP[activeConfig.activeVoice] || voiceName;
          log.info(`⏱️ [pipeline] Answer -> business setup ready: ${Date.now() - startupStartTime}ms`);

          const { functionDeclarations: customToolDeclarations, promptSection: customObjectsPrompt } = buildCustomObjectTools(customObjects);
          let knowledgeBasePrompt = "";
          if (orgHasKnowledgeBase) {
            customToolDeclarations.push({
              name: "search_knowledge_base",
              description: "Search this business's knowledge base for facts, policies, or answers to the caller's question. Use this whenever the caller asks something you're not certain about rather than guessing.",
              parameters: { type: "OBJECT", properties: { query: { type: "STRING", description: "Search terms describing what to look up" } }, required: ["query"] }
            });
            knowledgeBasePrompt = `
──────────
KNOWLEDGE BASE
──────────
If the caller asks anything about this business, its products, services, pricing, or policies, call the 'search_knowledge_base' tool with their question to get the exact facts before answering. Do not make up or guess details — use the retrieved text to explain. Keep the spoken answer short — one or two sentences, the direct answer only, not a full lecture. Long explanations add real delay before you start speaking; the caller can always ask a follow-up if they want more.
`;
          }

          let activeQuestions = questionsList;
          if (customQuestions && Array.isArray(customQuestions) && customQuestions.length > 0) {
            activeQuestions = customQuestions;
            vobizCallQuestions.delete(phoneCacheKey(sanitizedPhone));
          }

          // Normalize once — accepts legacy plain strings or the newer
          // { label, question } shape, so a short label (set in the
          // workflow builder) survives into save_question_response while
          // the AI still only ever sees/speaks `.question`.
          const normalizedQuestions = postCallAgents.normalizeQuestions(activeQuestions);

          const dynamicQuestionnairePrompt = `
──────────
MANDATORY QUESTIONNAIRE PROTOCOL
──────────
You MUST ask the caller the following questions ONE BY ONE, to understand what they need — do not describe yourself as being in any particular industry beyond what's already been established above. Do NOT ask them all at once. Wait for their response for each question:
${questionnaire.formatQuestionnaireList(normalizedQuestions)}

When the user answers a question, you must immediately call the tool 'save_question_response' with the exact question you asked and the answer they gave, and then move to the next question.

Before asking any question, check whether the caller has already told you the answer earlier in this same conversation (either volunteered on their own, or answered while responding to a different question). If so, do NOT ask it again — immediately call 'save_question_response' with that question and what they already told you, and move straight to the next question they have not answered yet.

If the caller's reply is not a plain answer to what you asked — for example they ask "how does that work", "explain", "tell me more", or respond with a question of their own instead of answering — do NOT log it as a Yes/No answer and do NOT move to the next question yet. First use the 'search_policy_knowledge_base' tool to find the real answer and explain it to them in your own words, in the same language they're using — keep it to one or two short sentences, not a full lecture, since long explanations add real delay before you start speaking. Only call 'save_question_response' and move to the next question once they have actually answered what you asked.

Be extra careful with Yes/No answers specifically — "yes" and "no" (and their Tamil/Hindi/English equivalents: aama/illa, haan/nahi, correct/not correct) sound similar over a phone line and are easy to log backwards. Getting this one word wrong sends the rest of the conversation down the wrong branch — for example asking "how many policies do you have" after mishearing a "No" as a "Yes" to "do you have a policy". If you are not fully confident which one the caller said, quickly confirm before saving it (e.g. "So that's a No, right?") rather than guessing.

Never call 'save_question_response' unless the caller has actually, verbally answered that specific question earlier in THIS call. Do not guess, assume, or pre-fill an answer (e.g. assuming "Yes" just because you're calling to offer something, or because a caller sounds friendly). If you have not yet asked a question and gotten a real reply to it, it has no answer to save yet.
`;

          const endCallPrompt = `
──────────
ENDING THE CALL
──────────
Once the conversation has naturally wrapped up (goals met, caller says goodbye, or caller has nothing further), say a brief warm goodbye and then call the 'end_call' tool.`;

          toolDeclarations = [
            ...(customObjects.length === 0 ? [LEGACY_INSURANCE_TOOL_DECLARATION] : []),
            ...BASE_TOOL_DECLARATIONS,
            { name: "end_call", description: "End the current call. Call this only after saying goodbye to the caller.", parameters: { type: "OBJECT", properties: {} } },
            ...customToolDeclarations,
          ];

          systemPrompt = (customObjects.length > 0
            ? buildRuntimePrompt(activeConfig) + "\n" + customObjectsPrompt + knowledgeBasePrompt + endCallPrompt
            : buildRuntimePrompt(activeConfig) + "\n" + dynamicQuestionnairePrompt + knowledgeBasePrompt + endCallPrompt
          ) + `
──────────
TEXT OUTPUT → SPOKEN AUDIO
──────────
You are a text model, but everything you write here gets read aloud verbatim by a TTS voice — there is no separate "written mode". Apply the speech style, contractions, and disfluency rules above to every reply exactly as if you were speaking them, not writing a message. Never produce complete formal written sentences, bullet points, or lists — write the words the way you'd actually say them out loud, including the contracted/softened forms. Keep each reply to 1-2 short spoken sentences.`;

          // The greeting also does not depend on STT being ready. Start TTS as
          // soon as the prompt/config is available, while the STT WebSocket
          // finishes its handshake in parallel. The caller hears the greeting
          // as soon as TTS produces its first audio instead of waiting for the
          // entire startup chain.
          sttReadyPromise.then(() => {
            sessionReady = true;
            sessionReadyResolve();
          }).catch((err) => {
            log.error("❌ [pipeline] STT startup error:", err.message);
            sessionReady = true;
            sessionReadyResolve();
          });

          // Fixed warm greeting, synthesized directly (no LLM round-trip needed
          // for a scripted opening line) — mirrors the audio-to-audio engine's
          // triggerGreetingIfReady() behavior.
          const timeOfDay = getTimeOfDay(new Date(), "Asia/Kolkata");
          const greetingText = `Vanakkam sir/mam, ${timeOfDay}! Naanga ChiefVoice-la irundhu call panrom. Sollunga, enna assist venum, epdi help pannalam?`;
          history.push({ role: "model", parts: [{ text: greetingText }] });
          transcriptLines.push({ role: "ai", text: greetingText });
          if (global.broadcastLog) global.broadcastLog(`🤖 Agent: "${greetingText}"`, { type: "transcript", role: "ai", text: greetingText });
          synthesizeAndSend(greetingText, generation, () => {
            log.info(`⏱️ [pipeline] Answer -> first greeting audio: ${Date.now() - startupStartTime}ms`);
          }).catch(err => log.error("❌ [pipeline] Greeting TTS error:", err.message));

          break;
        }

        case "media":
          if (msg.media.track === "inbound") {
            await sessionReadyPromise;
            if (!sttSession) return;
            const rawPCM = Buffer.from(msg.media.payload, "base64"); // already 16kHz L16
            await sttSession.sendRealtimeInput({ audio: { data: rawPCM.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
            totalInboundAudioBytes += rawPCM.length;
            recordStream.write(rawPCM);
          }
          break;

        case "stop":
          log.info(`🔌 [pipeline] Vobiz Stream stopped: ${streamId}`);
          await finalizeCall();
          if (sttSession) try { await sttSession.close(); } catch {}
          break;
      }
    } catch (err) {
      log.error("❌ [pipeline] Vobiz Message error:", err.message);
    }
  });

  async function openSttSession() {
    // The @google/genai SDK silently strips realtimeInputConfig/VAD keys
    // from the outgoing setup payload (same issue documented in
    // vobizProxy.js/geminiProxy.js) — intercept the raw WS send once to
    // inject them in the snake_case format the Live API backend actually
    // reads. This session's only job is fast turn detection, so we push
    // silence_duration_ms lower (250ms) than the audio-to-audio engine
    // uses (350-600ms) — there's no spoken-reply naturalness tradeoff
    // to protect here, just "notice the caller stopped talking" speed.
    const originalSend = ws.prototype.send;
    ws.prototype.send = function (data, options, callback) {
      try {
        const payload = JSON.parse(data);
        if (payload.setup) {
          payload.setup.realtime_input_config = {
            automatic_activity_detection: {
              disabled: false,
              start_of_speech_sensitivity: "START_SENSITIVITY_HIGH",
              end_of_speech_sensitivity: "END_SENSITIVITY_HIGH",
              silence_duration_ms: 250,
            },
          };
          delete payload.setup.realtimeInputConfig;
          data = JSON.stringify(payload);
          log.info("⚙️ [pipeline] STT session: injected low-latency VAD (silence: 250ms, sensitivity: HIGH)");
        }
      } catch (_) {}
      ws.prototype.send = originalSend;
      return originalSend.call(this, data, options, callback);
    };

    sttSession = await (aiClient || await genai.getClientForOrg(orgId)).live.connect({
      model: STT_MODEL,
      config: {
        systemInstruction: { parts: [{ text: "You are a silent transcription service. Never produce any spoken or written reply." }] },
        // This model only supports native AUDIO output — requesting TEXT
        // makes it close the session immediately (code 1007). We ask for
        // AUDIO to keep the session alive but never forward/use that
        // audio output; only serverContent.inputTranscription is used.
        responseModalities: ["AUDIO"],
        inputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
            startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
          },
          turnCoverage: "TURN_INCLUDES_ALL_INPUT",
        },
      },
      callbacks: bindScopedCallbacks({
        onmessage: async (response) => {
          if (!isActive) return;
          try {
            if (response.serverContent?.inputTranscription?.text) {
              const text = response.serverContent.inputTranscription.text;
              currentTurnBuffer += text;
              if (turnBusy) {
                generation++;
                turnBusy = false;
                stopPacing();
                sendJson(vobizWs, { event: "clearAudio", streamId });
              }
            }
            if (response.serverContent?.turnComplete) {
              const utterance = currentTurnBuffer.trim();
              currentTurnBuffer = "";
              if (utterance) {
                log.info(`👤 [pipeline] Vobiz Caller: "${utterance}"`);
                transcriptLines.push({ role: "user", text: utterance });
                if (global.broadcastLog) global.broadcastLog(`👤 Caller: "${utterance}"`, { type: "transcript", role: "user", text: utterance });

                extractContactAndTrigger(utterance, transcriptLines, contactState.email, contactState.phone, contactState.emailPending, contactState.whatsAppPending)
                  .then(result => {
                    if (result.email) { contactState.email = result.email; contactState.emailPending = false; }
                    if (result.phone) { contactState.phone = result.phone; contactState.whatsAppPending = false; }
                    if (result.shouldSendEmail) contactState.emailPending = true;
                    if (result.shouldSendWhatsApp) contactState.whatsAppPending = true;
                  })
                  .catch(err => log.warn("⚠️ [pipeline] Contact extractor error:", err.message));

                runTurn(utterance).catch(err => log.error("❌ [pipeline] Turn error:", err.message));
              }
            }
            const usage = response.usageMetadata;
            if (usage) liveInputTokens = usage.promptTokenCount || liveInputTokens;
          } catch (err) {
            log.error("❌ [pipeline] STT onmessage error:", err.stack || err.message);
          }
        },
        onerror: (err) => log.error("❌ [pipeline] STT error:", err.message || err),
        onclose: (e) => { log.info(`🔌 [pipeline] STT closed. Code: ${e?.code}, Reason: ${e?.reason || "none"}`); stopPacing(); },
      }),
    });
  }

  async function runTurn(userText) {
    turnBusy = true;
    const myGeneration = generation;
    const turnStartTime = Date.now(); // caller just stopped talking (turnComplete)
    let firstAudioLogged = false;
    history.push({ role: "user", parts: [{ text: userText }] });

    let sentenceBuffer = "";
    let fullReplyText = "";
    let ttsChain = Promise.resolve();
    function enqueueSentence(sentence) {
      ttsChain = ttsChain.then(() => synthesizeAndSend(sentence, myGeneration, () => {
        if (!firstAudioLogged) {
          firstAudioLogged = true;
          log.info(`⏱️ [pipeline] Latency (caller stopped talking -> first agent audio): ${Date.now() - turnStartTime}ms`);
        }
      }));
    }

    try {
      const stream = await (aiClient || await genai.getClientForOrg(resolvedOrgId)).models.generateContentStream({
        model: LLM_MODEL,
        contents: history,
        config: {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools: [{ functionDeclarations: toolDeclarations }],
          temperature: 0.9,
          maxOutputTokens: 200,
        },
      });

      const functionCalls = [];
      for await (const chunk of stream) {
        if (myGeneration !== generation) break;
        if (chunk.usageMetadata) {
          liveInputTokens = chunk.usageMetadata.promptTokenCount || liveInputTokens;
          liveOutputTokens = chunk.usageMetadata.candidatesTokenCount || liveOutputTokens;
        }
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.functionCall) {
            functionCalls.push(part.functionCall);
          } else if (part.text) {
            fullReplyText += part.text;
            sentenceBuffer += part.text;
            const { complete, rest } = extractCompleteSentences(sentenceBuffer);
            sentenceBuffer = rest;
            for (const s of complete) enqueueSentence(s);
          }
        }
      }
      if (myGeneration === generation && sentenceBuffer.trim()) enqueueSentence(sentenceBuffer.trim());
      await ttsChain;

      if (functionCalls.length > 0 && myGeneration === generation) {
        for (const call of functionCalls) {
          log.info(`🛠️ [pipeline] Tool Call: Executing ${call.name}`, JSON.stringify(call.args || {}));
          let result = {};
          if (call.name === "search_policy_knowledge_base") {
            result = await handleSearchPolicyKnowledgeBase(call.args.query);
          } else if (call.name === "save_question_response") {
            result = await handleSaveQuestionResponse(resolvedOrgId, generatedCallId, getCallerNumber(), call.args.question, call.args.answer, normalizedQuestions);
          } else if (call.name === "send_email_document") {
            result = await handleSendEmailDocument(call.args.recipient_email, call.args.subject, call.args.body, call.args.document_type);
          } else if (call.name === "send_whatsapp_message") {
            result = await handleSendWhatsappMessage(call.args.whatsapp_number, call.args.message, call.args.document_url, call.args.file_name);
          } else if (call.name === "save_enquiry") {
            result = await handleSaveEnquiry(resolvedOrgId, generatedCallId, call.args);
          } else if (call.name === "search_knowledge_base" && resolvedOrgId) {
            try {
              const matches = await knowledgeBase.search(resolvedOrgId, call.args.query, 3);
              result = matches.length ? { results: matches.map((m) => m.content) } : { results: [], note: "No matching content found in the knowledge base." };
            } catch (err) { result = { error: err.message }; }
          } else if (call.name === "end_call") {
            log.info(`👋 [pipeline] end_call requested — hanging up in 3.5s | Call ID: ${generatedCallId}`);
            setTimeout(() => hangupVobizCall(callId, resolvedOrgId), 3500);
            result = { success: true, note: "Call will end shortly." };
          } else if (resolvedOrgId) {
            const objectResult = await handleObjectToolCall(objectsEngine, resolvedOrgId, customObjects, call.name, call.args);
            if (objectResult) result = objectResult;
          }
        }
      }

      if (fullReplyText.trim()) {
        history.push({ role: "model", parts: [{ text: fullReplyText }] });
        transcriptLines.push({ role: "ai", text: fullReplyText.trim() });
        if (global.broadcastLog) global.broadcastLog(`🤖 Agent: "${fullReplyText.trim()}"`, { type: "transcript", role: "ai", text: fullReplyText.trim() });
      }
    } catch (err) {
      log.error("❌ [pipeline] LLM stream error:", err.message);
    } finally {
      if (myGeneration === generation) turnBusy = false;
    }
  }

  async function synthesizeAndSend(sentence, myGeneration, onFirstAudio) {
    if (!sentence || myGeneration !== generation || !isActive) return;
    try {
      const res = await (aiClient || await genai.getClientForOrg(resolvedOrgId)).models.generateContent({
        model: TTS_MODEL,
        contents: [{ role: "user", parts: [{ text: sentence }] }],
        config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
      });
      if (myGeneration !== generation || !isActive) return;

      const audioPart = res.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith("audio/"));
      if (!audioPart) return;
      if (res.usageMetadata) liveOutputTokens += res.usageMetadata.candidatesTokenCount || 0;

      if (onFirstAudio) onFirstAudio();

      const raw24kPCM = Buffer.from(audioPart.inlineData.data, "base64");
      totalOutboundAudioBytes += raw24kPCM.length;
      const pcm16k = resample24To16(raw24kPCM);
      for (let i = 0; i < pcm16k.length; i++) outboundQueue.push(pcm16k[i]);
      startPacing();
      recordStream.write(pcm16k);
    } catch (err) {
      log.error("❌ [pipeline] TTS error:", err.message);
    }
  }

  async function finalizeCall() {
    if (isFinalized) return;
    isFinalized = true;
    isActive = false;
    stopPacing();
    recordStream.end();
    const duration = Math.round((Date.now() - startTime) / 1000);
    await new Promise(r => recordStream.on("finish", r));

    const callerNumber = vobizCallNumbers.get(callId) || "Vobiz Call";
    vobizCallNumbers.delete(callId);
    const orgId = vobizCallOrgs.get(callId) || null;
    vobizCallOrgs.delete(callId);
    vobizCallWorkspaces.delete(callId);
    const direction = vobizCallDirection.get(callId) || "unknown";
    vobizCallDirection.delete(callId);

    if (global.broadcastLog) {
      global.broadcastLog(`🛑 Call completed | Caller: ${callerNumber} | Duration: ${duration}s | Total Tokens: ${liveInputTokens + liveOutputTokens}`, { type: "system", duration, inputTokens: liveInputTokens, outputTokens: liveOutputTokens });
    }

    appendCallLog(generatedCallId, {
      type: "call_summary", callerNumber, orgId, direction, durationSeconds: duration,
      liveInputTokens, liveOutputTokens, transcriptLines, engine: "pipeline",
    });

    processPostCallData(generatedCallId, callerNumber, tempPcmPath, duration, transcriptLines, activeConfig, liveInputTokens, liveOutputTokens, totalInboundAudioBytes, totalOutboundAudioBytes, orgId, direction)
      .catch(err => log.error("❌ [pipeline] Post-call error for Vobiz:", err.message));
  }

  onScopedEvent(vobizWs, "close", async () => {
    log.info(`🌐 [pipeline] Vobiz WS closed | Call ID: ${generatedCallId}`);
    await finalizeCall();
    if (sttSession) try { await sttSession.close(); } catch {}
  });

  onScopedEvent(vobizWs, "error", err => {
    log.error("❌ [pipeline] Vobiz WS error:", err.message);
    isActive = false;
  });
}

module.exports = { handleVobizSession };
