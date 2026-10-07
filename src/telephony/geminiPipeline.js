const { recordingKey } = require('../storage/workspaceKeys');
const { onScopedEvent, bindScopedCallbacks } = require("../workspaces/scope");
// ============================================================
// services/geminiPipeline.js
//
// STT → LLM → TTS pipeline (browser /session path), as an
// alternative engine to the audio-to-audio Live model in
// geminiProxy.js. Selected via VOICE_ENGINE=pipeline (default).
//
// STAGE 1 — STT: a Gemini Live session in TEXT-only mode, used
//   purely for its streaming transcription + built-in VAD/turn
//   detection. We never speak its model output back to the
//   caller — turnComplete just marks "caller finished talking".
//
// STAGE 2 — LLM: gemini-2.5-flash text generation, streamed,
//   with the same tool declarations (RAG search, save answer)
//   as the audio-to-audio engine.
//
// STAGE 3 — TTS: gemini-2.5-flash-preview-tts, called per
//   completed sentence as the LLM streams, so synthesis for
//   sentence N overlaps with the LLM still generating sentence
//   N+1 — this pipelining is what keeps perceived latency down
//   compared to waiting for the full reply before speaking.
// ============================================================

const fs = require("fs");
const path = require("path");
const storage = require("../storage");
const { getConfigForOrg, buildRuntimePrompt } = require("../config/agentConfig");
const db = require("../db/repository");
const { handleSearchPolicyKnowledgeBase, handleSaveQuestionResponse, handleSaveEnquiry } = require("./geminiProxy");

// Same shared Vertex-configured client as geminiProxy.js.
const genai = require("../ai/googleAiClient");
const postCallAgents = require("../ai/postCallAgents");
const questionnaire = require("./questionnaire");
const { getLogger } = require("../observability/logger");
const log = getLogger("telephony.geminiPipeline");

// Same voice map as geminiProxy.js — keep both engines sounding
// consistent for a given "activeVoice" persona selection.
const VOICE_MAP = {
  Arjun: "Achird",
  Priya: "Sulafat",
  Dev:   "Sadaltager",
  Kavya: "Vindemiatrix",
};

const STT_MODEL = "gemini-live-2.5-flash-preview-native-audio-09-2025";
const LLM_MODEL = "gemini-2.5-flash-lite";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

function getWavHeader(dataLength, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);                                      h.writeUInt32LE(dataLength + 36, 4);
  h.write("WAVE", 8);                                      h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);                                 h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);                           h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  h.writeUInt16LE(channels * bitsPerSample / 8, 32);       h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36);                                     h.writeUInt32LE(dataLength, 40);
  return h;
}

// Gemini TTS returns 24kHz PCM16 mono, same as the Live audio-to-audio
// model — reuse the same downsample ratio for the recording file.
function resample24To16(buffer24) {
  const aligned = new Uint8Array(buffer24.length);
  aligned.set(buffer24);
  const s24 = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
  const s16 = new Int16Array(Math.round(s24.length * 2 / 3));
  for (let i = 0; i < s16.length; i++) {
    const pos = i * 1.5;
    const lo = Math.floor(pos);
    const hi = Math.min(s24.length - 1, lo + 1);
    s16[i] = s24[lo] * (1 - (pos - lo)) + s24[hi] * (pos - lo);
  }
  return Buffer.from(s16.buffer, s16.byteOffset, s16.byteLength);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Splits on sentence-ending punctuation so TTS can start on sentence 1
// while the LLM is still streaming sentence 2+. Returns { complete, rest }.
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

const TOOL_DECLARATIONS = [
  {
    functionDeclarations: [
      {
        name: "search_policy_knowledge_base",
        description: "Search the insurance policy documents database for definitions, policy terms, coverages, limits, and rules.",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING", description: "Specific search terms or keywords to query in the insurance policy database" } },
          required: ["query"]
        }
      },
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
        name: "save_enquiry",
        description: "Save a caller's question or request that you couldn't fully resolve on this call, so a team member can follow up. Call this quietly in the background as soon as you have any of the details — don't wait until the end of the call, and don't announce it as a database save.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Caller's name, if known" },
            phone: { type: "STRING", description: "Caller's phone number, if known" },
            email: { type: "STRING", description: "Caller's email, if known" },
            location: { type: "STRING", description: "Caller's location, if mentioned" },
            query_text: { type: "STRING", description: "What the caller asked or needs help with" }
          },
          required: ["query_text"]
        }
      }
    ]
  }
];

async function handleBrowserSession(browserWs, sessionContext = null) {
  const orgId = sessionContext?.orgId ? String(sessionContext.orgId) : null;
  if (!orgId) throw new Error("Authenticated organization context is required for browser voice sessions");
  let isActive = true;
  const startTime = Date.now();
  const callId = `pcall_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tempDir = path.join(__dirname, "../../temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempPcmPath = path.join(tempDir, `${callId}.pcm`);
  const recordStream = fs.createWriteStream(tempPcmPath);
  const transcriptLines = [];
  const history = []; // [{role: "user"|"model", parts: [{text}]}]

  const activeConfig = await getConfigForOrg(orgId);
  const aiClient = await genai.getClientForOrg(orgId);
  const voiceName = VOICE_MAP[activeConfig.activeVoice] || "Achird";

  // Fetch this authenticated session's organization questionnaire — fall
  // back to a generic, industry-neutral set only if that lookup fails or
  // db isn't configured at all (see services/db.js's getQuestions(), which
  // already returns the org's actual industry-scoped defaults).
  const genericFallbackQuestions = [
    "Unga full name enna, sollunga?",
    "Ugaluku enna vishayathula help venum?",
    "Unga budget matum timeline enna?",
    "Ugaluku edhavadhu specific requirements iruka?"
  ];
  let questionsList = genericFallbackQuestions;
  try { questionsList = await db.getQuestions(orgId); }
  catch (err) { log.error("❌ Failed to load org questionnaire, using generic defaults:", err.message); }
  const normalizedQuestions = postCallAgents.normalizeQuestions(questionsList);
  const questionnairePrompt = `
──────────
MANDATORY QUESTIONNAIRE PROTOCOL
──────────
You MUST ask the caller the following questions ONE BY ONE, to understand what they need — do not describe yourself as being in any particular industry beyond what's already been established above. Do NOT ask them all at once. Wait for their response for each question:
${questionnaire.formatQuestionnaireList(normalizedQuestions)}

When the user answers a question, you must immediately call the tool 'save_question_response' with the exact question you asked and the answer they gave, and then move to the next question.

Before asking any question, check whether the caller has already told you the answer earlier in this same conversation (either volunteered on their own, or answered while responding to a different question). If so, do NOT ask it again — immediately call 'save_question_response' with that question and what they already told you, and move straight to the next question they have not answered yet.

If the caller's reply is not a plain answer to what you asked — for example they ask "how does that work", "explain", "tell me more", or respond with a question of their own instead of answering — do NOT log it as a Yes/No answer and do NOT move to the next question yet. First use the 'search_policy_knowledge_base' tool to find the real answer and explain it to them in your own words, in the same language they're using. Only call 'save_question_response' and move to the next question once they have actually answered what you asked.

Be extra careful with Yes/No answers specifically — "yes" and "no" (and their Tamil/Hindi/English equivalents: aama/illa, haan/nahi, correct/not correct) sound similar over a phone line and are easy to log backwards. Getting this one word wrong sends the rest of the conversation down the wrong branch — for example asking "how many policies do you have" after mishearing a "No" as a "Yes" to "do you have a policy". If you are not fully confident which one the caller said, quickly confirm before saving it (e.g. "So that's a No, right?") rather than guessing.

Never call 'save_question_response' unless the caller has actually, verbally answered that specific question earlier in THIS call. Do not guess, assume, or pre-fill an answer (e.g. assuming "Yes" just because you're calling to offer something, or because a caller sounds friendly). If you have not yet asked a question and gotten a real reply to it, it has no answer to save yet.

If the user has any policy or general insurance questions at any point during the call, call the 'search_policy_knowledge_base' tool with their search query to get the exact facts and answers. Do not make up any insurance coverage details or terms. Use the retrieved document text to explain.

Never call 'save_question_response' unless the caller has actually, verbally answered that specific question earlier in THIS call. Do not guess, assume, or pre-fill an answer (e.g. assuming "Yes" just because you're calling to offer something, or because a caller sounds friendly). If you have not yet asked a question and gotten a real reply to it, it has no answer to save yet.

──────────
TEXT OUTPUT → SPOKEN AUDIO
──────────
You are a text model, but everything you write here gets read aloud verbatim by a TTS voice — there is no separate "written mode". Apply the speech style, contractions, and disfluency rules above to every reply exactly as if you were speaking them, not writing a message. Never produce complete formal written sentences, bullet points, or lists — write the words the way you'd actually say them out loud, including the contracted/softened forms. Keep each reply to 1-2 short spoken sentences.`;
  const systemPrompt = buildRuntimePrompt(activeConfig) + "\n" + questionnairePrompt;

  log.info(`📞 [pipeline] New call | ID: ${callId} | Voice: ${activeConfig.activeVoice} (${voiceName})`);

  let totalInboundAudioBytes = 0;
  let totalOutboundAudioBytes = 0;
  let sttInputTokens = 0, llmInputTokens = 0, llmOutputTokens = 0, ttsOutputTokens = 0;

  let isFinalized = false;
  let sttSession = null;
  let currentTurnBuffer = "";
  let turnBusy = false;      // true while LLM/TTS are handling the previous turn
  let generation = 0;        // bumped on barge-in to cancel stale TTS output

  // ── STT stage: Gemini Live, TEXT-only, transcription + VAD only ──
  try {
    // The @google/genai SDK silently strips realtimeInputConfig/VAD keys
    // from the outgoing setup payload — intercept the raw WS send once to
    // inject them in the snake_case format the Live API backend actually
    // reads. This session's only job is fast turn detection, so silence
    // duration is pushed lower (250ms) than the audio-to-audio engine's
    // spoken-reply pacing needs — no naturalness tradeoff to protect here.
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

    sttSession = await aiClient.live.connect({
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

          if (response.serverContent?.inputTranscription?.text) {
            const text = response.serverContent.inputTranscription.text;
            currentTurnBuffer += text;

            // Barge-in: caller started talking again while agent was speaking.
            if (turnBusy) {
              generation++;
              turnBusy = false;
              send(browserWs, { type: "interrupted" });
            }
          }

          if (response.serverContent?.turnComplete) {
            const utterance = currentTurnBuffer.trim();
            currentTurnBuffer = "";
            if (utterance) {
              log.info(`👤 [pipeline] Caller: "${utterance}"`);
              transcriptLines.push({ role: "user", text: utterance });
              send(browserWs, { type: "transcript", role: "user", text: utterance });
              if (global.broadcastLog) global.broadcastLog(`👤 Caller: "${utterance}"`, { type: "transcript", role: "user", text: utterance });
              runTurn(utterance).catch(err => log.error("❌ [pipeline] Turn error:", err.message));
            }
          }

          const usage = response.usageMetadata;
          if (usage) sttInputTokens = usage.promptTokenCount || sttInputTokens;
        },
        onerror: (err) => log.error("❌ [pipeline] STT error:", err.message || err),
        onclose: (e) => log.info(`🔌 [pipeline] STT closed. Code: ${e?.code}, Reason: ${e?.reason || "none"}`),
      }),
    });
    log.info(`✅ [pipeline] STT session open | Call ID: ${callId}`);
    send(browserWs, { type: "ready" });
    if (global.broadcastLog) global.broadcastLog(`📞 Voice Session Open (pipeline engine) | Call ID: ${callId}`, { type: "system", callId });
  } catch (err) {
    log.error("❌ [pipeline] STT session failed:", err.message);
    send(browserWs, { type: "error", message: "Failed to connect to AI. Check API key." });
    recordStream.close();
    try { fs.unlinkSync(tempPcmPath); } catch {}
    browserWs.close();
    return;
  }

  // ── LLM + TTS stage, run once per completed caller turn ──
  async function runTurn(userText) {
    turnBusy = true;
    const myGeneration = generation;
    const turnStartTime = Date.now(); // caller just stopped talking (turnComplete)
    let firstAudioLogged = false;
    history.push({ role: "user", parts: [{ text: userText }] });

    let sentenceBuffer = "";
    let fullReplyText = "";
    let ttsChain = Promise.resolve(); // chain to keep sentence audio in order

    function enqueueSentence(sentence) {
      ttsChain = ttsChain.then(() => synthesizeAndSend(sentence, myGeneration, () => {
        if (!firstAudioLogged) {
          firstAudioLogged = true;
          log.info(`⏱️ [pipeline] Latency (caller stopped talking -> first agent audio): ${Date.now() - turnStartTime}ms`);
        }
      }));
    }

    try {
      const stream = await aiClient.models.generateContentStream({
        model: LLM_MODEL,
        contents: history,
        config: {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools: TOOL_DECLARATIONS,
          temperature: 0.9,
          maxOutputTokens: 200,
        },
      });

      const functionCalls = [];

      for await (const chunk of stream) {
        if (myGeneration !== generation) break; // barged in — abandon this turn

        if (chunk.usageMetadata) {
          llmInputTokens = chunk.usageMetadata.promptTokenCount || llmInputTokens;
          llmOutputTokens = chunk.usageMetadata.candidatesTokenCount || llmOutputTokens;
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

      if (myGeneration === generation && sentenceBuffer.trim()) {
        enqueueSentence(sentenceBuffer.trim());
      }

      await ttsChain;

      if (functionCalls.length > 0 && myGeneration === generation) {
        for (const call of functionCalls) {
          log.info(`🛠️ [pipeline] Tool Call: Executing ${call.name}`);
          if (call.name === "search_policy_knowledge_base") {
            await handleSearchPolicyKnowledgeBase(call.args.query);
          } else if (call.name === "save_question_response") {
            const phone = activeConfig.activePhone || "Web Call";
            await handleSaveQuestionResponse(orgId, "web_call", phone, call.args.question, call.args.answer, normalizedQuestions);
          } else if (call.name === "save_enquiry") {
            await handleSaveEnquiry(orgId, "web_call", call.args);
          }
        }
      }

      if (fullReplyText.trim()) {
        history.push({ role: "model", parts: [{ text: fullReplyText }] });
        transcriptLines.push({ role: "ai", text: fullReplyText.trim() });
        send(browserWs, { type: "transcript", role: "ai", text: fullReplyText.trim() });
        if (global.broadcastLog) global.broadcastLog(`🤖 Agent: "${fullReplyText.trim()}"`, { type: "transcript", role: "ai", text: fullReplyText.trim() });
      }
    } catch (err) {
      log.error("❌ [pipeline] LLM stream error:", err.message);
    } finally {
      if (myGeneration === generation) {
        turnBusy = false;
        send(browserWs, { type: "turn_complete" });
      }
    }
  }

  // ── TTS: synthesize one sentence and stream its audio to the browser ──
  async function synthesizeAndSend(sentence, myGeneration, onFirstAudio) {
    if (!sentence || myGeneration !== generation || !isActive) return;
    try {
      const res = await aiClient.models.generateContent({
        model: TTS_MODEL,
        contents: [{ role: "user", parts: [{ text: sentence }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      });

      if (myGeneration !== generation || !isActive) return; // barged in mid-synthesis

      const audioPart = res.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith("audio/"));
      if (!audioPart) return;
      if (onFirstAudio) onFirstAudio();

      if (res.usageMetadata) {
        ttsOutputTokens += res.usageMetadata.candidatesTokenCount || 0;
      }

      send(browserWs, { type: "audio", data: audioPart.inlineData.data, mimeType: audioPart.inlineData.mimeType });
      const raw = Buffer.from(audioPart.inlineData.data, "base64");
      totalOutboundAudioBytes += raw.length;
      recordStream.write(resample24To16(raw));
    } catch (err) {
      log.error("❌ [pipeline] TTS error:", err.message);
    }
  }

  onScopedEvent(browserWs,"message", async (rawMsg) => {
    if (!isActive || !sttSession) return;
    try {
      const msg = JSON.parse(rawMsg.toString());
      if (msg.type === "audio") {
        await sttSession.sendRealtimeInput({ audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" } });
        const pcmData = Buffer.from(msg.data, "base64");
        totalInboundAudioBytes += pcmData.length;
        recordStream.write(pcmData);
      } else if (msg.type === "stop") {
        await finalizeCall();
        try { await sttSession.close(); } catch {}
      }
    } catch (err) {
      log.error("❌ [pipeline] Message error:", err.message);
    }
  });

  async function finalizeCall() {
    if (isFinalized) return;
    isFinalized = true;
    isActive = false;
    recordStream.end();
    const duration = Math.round((Date.now() - startTime) / 1000);
    await new Promise(r => recordStream.on("finish", r));
    if (global.broadcastLog) {
      global.broadcastLog(`🛑 Call completed | Duration: ${duration}s`, { type: "system", duration });
    }
    processPostCallData(callId, tempPcmPath, duration, transcriptLines, activeConfig, orgId,
      sttInputTokens, llmInputTokens, llmOutputTokens, ttsOutputTokens,
      totalInboundAudioBytes, totalOutboundAudioBytes)
      .catch(err => log.error("❌ [pipeline] Post-call error:", err.message));
  }

  onScopedEvent(browserWs,"close", async () => {
    log.info(`🌐 [pipeline] Disconnected | Call ID: ${callId}`);
    await finalizeCall();
    if (sttSession) try { await sttSession.close(); } catch {}
  });

  onScopedEvent(browserWs,"error", err => {
    log.error("❌ [pipeline] WS error:", err.message);
    isActive = false;
  });
}

async function processPostCallData(callId, tempPcmPath, durationSeconds, transcriptLines, activeConfig, orgId,
  sttInputTokens, llmInputTokens, llmOutputTokens, ttsOutputTokens, totalInboundAudioBytes, totalOutboundAudioBytes) {
  if (!fs.existsSync(tempPcmPath)) return;

  const rawPcm = fs.readFileSync(tempPcmPath);
  const wavBuffer = Buffer.concat([getWavHeader(rawPcm.length), rawPcm]);
  try { fs.unlinkSync(tempPcmPath); } catch {}

  let recordingUrl = null;
  let sentiment = "Neutral";
  const fullTranscript = transcriptLines.map(l => `${l.role === "user" ? "Caller" : "Agent"}: ${l.text}`).join("\n");

  if (!storage.isConfigured()) {
    log.warn("⚠️  [pipeline] Recording not saved — STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY / STORAGE_BUCKET are not set.");
  } else if (wavBuffer.length > 44) {
    try {
      recordingUrl = await storage.upload(recordingKey(callId), wavBuffer, { contentType: "audio/wav" });
      log.info(`💾 [pipeline] Recording uploaded: ${recordingUrl}`);
    } catch (uploadErr) {
      log.error("❌ [pipeline] Upload error:", uploadErr.message);
    }
  }

  let sentimentInputTokens = 0, sentimentOutputTokens = 0;
  const aiClient = await genai.getClientForOrg(orgId);
  if (transcriptLines.length > 0) {
    try {
      const res = await aiClient.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: `Analyze the sentiment of this call transcript. Reply with ONLY one word: Positive, Neutral, or Negative.\n\n${fullTranscript}`,
      });
      const t = res.text?.trim();
      if (["Positive", "Neutral", "Negative"].includes(t)) sentiment = t;
      if (res.usageMetadata) {
        sentimentInputTokens = res.usageMetadata.promptTokenCount || 0;
        sentimentOutputTokens = (res.usageMetadata.candidatesTokenCount || 0) + (res.usageMetadata.thoughtsTokenCount || 0);
      }
    } catch (err) {
      log.error("❌ [pipeline] Sentiment error:", err.message);
    }
  }

  const totalInputTokens = sttInputTokens + llmInputTokens + sentimentInputTokens;
  const totalOutputTokens = llmOutputTokens + ttsOutputTokens + sentimentOutputTokens;
  // gemini-2.5-flash text pricing: $0.30/$2.50 per 1M in/out; TTS billed as
  // output audio tokens at the flash-tts rate ($10/1M) — kept as a rough
  // estimate here since exact split isn't critical for this engine's cost log.
  const costUsd = (totalInputTokens * 0.0000003) + (llmOutputTokens * 0.0000025) + (ttsOutputTokens * 0.00001) + (sentimentOutputTokens * 0.0000025);

  log.info(`📊 [pipeline] Cost Breakdown: Input=${totalInputTokens}, Output=${totalOutputTokens}, Cost=$${costUsd.toFixed(5)}`);

  const transcriptForUi = transcriptLines.map((l) => ({
    speaker: l.role === "user" ? "Customer" : "AI",
    text: l.text,
    timestamp: new Date().toTimeString().split(" ")[0]
  }));
  db.create("calllogs", orgId, {
    leadName: "Web Call",
    duration: durationSeconds,
    status: "Completed",
    sentiment,
    intent: "Unknown",
    transcript: transcriptForUi,
    summary: fullTranscript.slice(0, 500),
    recordingUrl,
    direction: "unknown",
    createdAt: new Date().toISOString()
  }).then((savedLog) => {
    if (global.broadcastLog) {
      global.broadcastLog(`📼 Call logged: Web Call (${durationSeconds}s, ${sentiment})`, { type: "call_completed", orgId, callLog: savedLog });
    }
  }).catch((err) => log.error("❌ [pipeline] call_logs insert error:", err.message));
}

module.exports = { handleBrowserSession };
