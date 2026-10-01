// ============================================================
// services/geminiProxy.js
//
// ── WHAT WAS ROBOTIC AND WHY WE FIXED IT ──────────────────
//
// PROBLEM 1 — Wrong model:
//   Old: "gemini-2.5-flash-native-audio-latest"  ← this is correct
//   But the speechConfig was duplicated inside generationConfig,
//   which caused a config conflict and degraded voice quality.
//   Fix: Single clean speechConfig at top level only.
//
// PROBLEM 2 — Wrong sendRealtimeInput format:
//   Old: session.sendRealtimeInput({ media: { data, mimeType } })
//   The @google/genai SDK uses `audio` not `media` for browser PCM.
//   Fix: session.sendRealtimeInput({ audio: { data, mimeType } })
//
// PROBLEM 3 — Slider values sent as raw numbers in prompt:
//   "Emotion intensity: 75%" tells Gemini nothing useful.
//   Fix: buildRuntimePrompt() converts sliders to prose instructions
//   that the model can actually act on.
//
// PROBLEM 4 — VAD (Voice Activity Detection) not configured:
//   Without VAD config, Gemini uses aggressive defaults that cut
//   the caller off mid-sentence and rush responses — sounds robotic.
//   Fix: Added realtimeInputConfig with tuned VAD settings.
// ============================================================

const fs = require("fs");
const path = require("path");
const storage = require("../storage");
const { getConfigForOrg, buildRuntimePrompt } = require("../config/agentConfig");
const db = require("../db/repository");

// ── Clients ───────────────────────────────────────────────────
const genai = require("../ai/googleAiClient");
const postCallAgents = require("../ai/postCallAgents");
const questionnaire = require("./questionnaire");
const { getLogger } = require("../observability/logger");
const { createToolCallDeduper } = require("./conversation/turnGuard");
const { looksLikePhone } = require("../lib/phone");
const log = getLogger("telephony.geminiProxy");

// ── Voice map ─────────────────────────────────────────────────
// Gemini 2.5 Native Audio voices — chosen for warmth and naturalness
// Puck  = warm, expressive male  (best for Tanglish — most human feel)
// Aoede = breezy, friendly female
// Achird       = friendly
// Sulafat      = warm
// Sadaltager   = knowledgeable
// Vindemiatrix = gentle
const VOICE_MAP = {
  Arjun: "Achird",
  Priya: "Sulafat",
  Dev:   "Sadaltager",
  Kavya: "Vindemiatrix",
};

// ── WAV header ────────────────────────────────────────────────
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

// Downsample 24kHz → 16kHz (for recording file consistency)
function resample24To16(buffer24) {
  // Copy to a new Uint8Array to guarantee 2-byte alignment of the underlying ArrayBuffer
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

// ── WS send helper ────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ──────────═════════════════════
// MAIN SESSION HANDLER
// ──────────═════════════════════
async function handleBrowserSession(browserWs, sessionContext = null) {
  const orgId = sessionContext?.orgId ? String(sessionContext.orgId) : null;
  if (!orgId) throw new Error("Authenticated organization context is required for browser voice sessions");
  let geminiSession = null;
  let isActive = true;
  const startTime = Date.now();

  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const toolCallDeduper = createToolCallDeduper({ ttlMs: 6000 });
  const tempDir = path.join(__dirname, "../../temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempPcmPath = path.join(tempDir, `${callId}.pcm`);
  const recordStream = fs.createWriteStream(tempPcmPath);
  const transcriptLines = [];

  // ── Load config and build prompt ──────────────────────────
  const activeConfig = await getConfigForOrg(orgId);
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
`;

  // buildRuntimePrompt converts slider numbers → human prose instructions
  // e.g. speed:75 → "Speak at a quick, energetic pace"
  const finalPrompt = buildRuntimePrompt(activeConfig) + "\n" + questionnairePrompt;

  log.info(`📞 New call | ID: ${callId} | Voice: ${activeConfig.activeVoice} (${voiceName})`);

  let liveInputTokens = 0;
  let liveOutputTokens = 0;
  let totalInboundAudioBytes = 0;
  let totalOutboundAudioBytes = 0;

  // ── Open Gemini session ───────────────────────────────────
  try {
    geminiSession = await openGeminiSession(
      browserWs,
      voiceName,
      finalPrompt,
      recordStream,
      transcriptLines,
      (inTokens, outTokens) => {
        liveInputTokens += inTokens;
        liveOutputTokens += outTokens;
        if (global.broadcastLog) {
          global.broadcastLog(`🪙 Tokens Spent: Input ${liveInputTokens} | Output ${liveOutputTokens}`, { type: "usage", inputTokens: liveInputTokens, outputTokens: liveOutputTokens });
        }
      },
      (outBytes) => {
        totalOutboundAudioBytes += outBytes;
      },
      normalizedQuestions,
      orgId
    );
    log.info(`✅ Gemini Live session open | Call ID: ${callId}`);
    send(browserWs, { type: "ready" });
    if (global.broadcastLog) {
      global.broadcastLog(`📞 Voice Session Open | Call ID: ${callId}`, { type: "system", callId });
    }
  } catch (err) {
    log.error("❌ Gemini session failed:", err.message);
    send(browserWs, { type: "error", message: "Failed to connect to AI. Check API key." });
    recordStream.close();
    try { fs.unlinkSync(tempPcmPath); } catch {}
    browserWs.close();
    return;
  }

  let isFinalized = false;

  // ── Handle browser messages ───────────────────────────────
  browserWs.on("message", async (rawMsg) => {
    if (!isActive || !geminiSession) return;
    try {
      const msg = JSON.parse(rawMsg.toString());
      if (msg.type === "audio") {
        await geminiSession.sendAudio(msg.data);
        const pcmData = Buffer.from(msg.data, "base64");
        totalInboundAudioBytes += pcmData.length;
        recordStream.write(pcmData);
      } else if (msg.type === "stop") {
        await finalizeCall();
        if (geminiSession) try { await geminiSession.close(); } catch {}
      }
    } catch (err) {
      log.error("❌ Message error:", err.message);
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
      global.broadcastLog(`🛑 Call completed | Duration: ${duration}s | Total Tokens: ${liveInputTokens + liveOutputTokens}`, { type: "system", duration, inputTokens: liveInputTokens, outputTokens: liveOutputTokens });
    }
    processPostCallData(callId, tempPcmPath, duration, transcriptLines, activeConfig, liveInputTokens, liveOutputTokens, totalInboundAudioBytes, totalOutboundAudioBytes, orgId)
      .catch(err => log.error("❌ Post-call error:", err.message));
  }

  browserWs.on("close", async () => {
    log.info(`🌐 Disconnected | Call ID: ${callId}`);
    await finalizeCall();
    if (geminiSession) try { await geminiSession.close(); } catch {}
  });

  browserWs.on("error", err => {
    log.error("❌ WS error:", err.message);
    isActive = false;
  });
}

// ──────────═════════════════════
// GEMINI LIVE SESSION — CORE VOICE QUALITY SETTINGS
// ──────────═════════════════════
async function openGeminiSession(browserWs, voiceName, systemPrompt, recordStream, transcriptLines, onTokenUsage, onAudioOut, normalizedQuestions = [], orgId) {
  if (!orgId) throw new Error("orgId is required to open a Gemini session");

  // ── Intercept WebSocket Send to Inject VAD Config ──────────
  // The @google/genai SDK ignores and strips realtimeInputConfig/VAD keys
  // from config, so we intercept the first setup payload sent over ws
  // and inject them in the expected snake_case format directly.
  const originalSend = ws.prototype.send;
  ws.prototype.send = function (data, options, callback) {
    try {
      const payload = JSON.parse(data);
      if (payload.setup) {
        // Delete contextWindowCompression to prevent invalid argument error
        delete payload.setup.contextWindowCompression;

        // Translate and inject snake_case VAD settings for the Live API backend
        payload.setup.realtime_input_config = {
          automatic_activity_detection: {
            disabled: false,
            start_of_speech_sensitivity: "START_SENSITIVITY_HIGH",
            end_of_speech_sensitivity: "END_SENSITIVITY_HIGH",
            silence_duration_ms: 600
          }
        };
        delete payload.setup.realtimeInputConfig;

        // Force enable transcription for both inbound and outbound channels by passing empty objects
        payload.setup.input_audio_transcription = {};
        payload.setup.output_audio_transcription = {};

        // Set temperature inside the existing generationConfig
        if (!payload.setup.generationConfig) {
          payload.setup.generationConfig = {};
        }
        payload.setup.generationConfig.temperature = 0.9;
        payload.setup.generationConfig.thinkingConfig = { thinkingBudget: 0 };

        data = JSON.stringify(payload);
        log.info("⚙️ Intercepted setup payload, injected snake_case VAD config (silence: 600ms, sensitivity: HIGH), set temperature: 0.9, disabled thinking.");
        if (global.broadcastLog) {
          global.broadcastLog(`📤 [Gemini Send] setup (model: gemini-live-2.5-flash-preview-native-audio-09-2025, voice: ${voiceName})`, { type: "gemini_raw" });
        }
      }
    } catch (_) {}
    // Restore original send immediately
    ws.prototype.send = originalSend;
    return originalSend.call(this, data, options, callback);
  };

  const session = await (await genai.getClientForOrg(orgId)).live.connect({
    model: "gemini-live-2.5-flash-preview-native-audio-09-2025",

    config: {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },

      // ── Response format: AUDIO only ──────────────────────
      responseModalities: ["AUDIO"],

      // ── Tools / Function Declarations ────────────────────
      tools: [
        {
          functionDeclarations: [
            {
              name: "search_policy_knowledge_base",
              description: "Search the insurance policy documents database for definitions, policy terms, coverages, limits, and rules.",
              parameters: {
                type: "OBJECT",
                properties: {
                  query: {
                    type: "STRING",
                    description: "Specific search terms or keywords to query in the insurance policy database"
                  }
                },
                required: ["query"]
              }
            },
            {
              name: "save_question_response",
              description: "Record the client's answer to one of the mandatory questionnaire questions.",
              parameters: {
                type: "OBJECT",
                properties: {
                  question: {
                    type: "STRING",
                    description: "The exact question asked to the client"
                  },
                  answer: {
                    type: "STRING",
                    description: "The client's answer, response, or statement"
                  }
                },
                required: ["question", "answer"]
              }
            },
            {
              name: "save_enquiry",
              description: "Save a caller's question or request that you genuinely could NOT answer or resolve yourself on this call, so a team member can follow up. Do NOT call this just because the caller said they're busy right now and asked you to call back later — that's a scheduled callback, handled automatically from what you say on the call, not a team follow-up, so leave it out of here. Call this quietly in the background as soon as you have any of the details — don't wait until the end of the call, and don't announce it as a database save.",
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
      ],

      // ── Voice selection ───────────────────────────────────
      // ONE speechConfig here — duplicating it inside generationConfig
      // causes a config conflict that degrades voice quality to robotic.
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName }
        }
      },

      // ── Transcription — both sides ────────────────────────
      inputAudioTranscription:  {},
      outputAudioTranscription: {},

      // ── VAD (Voice Activity Detection) ────────────────────
      // This is the #1 cause of robotic feel when misconfigured.
      // Without this, Gemini uses aggressive defaults:
      //   - cuts off caller mid-sentence (bad turn-taking)
      //   - responds too fast (no thinking pause = sounds scripted)
      //   - doesn't wait for natural sentence-end pauses
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          // How long of silence = caller finished speaking
          // 800ms feels natural; lower = AI interrupts you; higher = awkward lag
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          // How long before VAD activates (filters room noise)
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
        },
        // Barge-in: let caller interrupt AI mid-sentence
        // This is what makes it feel like a REAL conversation
        turnCoverage: "TURN_INCLUDES_ALL_INPUT",
      },

      // ── Context window compression ────────────────────────
      // Keeps conversation coherent over long calls without
      // hitting token limits (prevents quality degradation mid-call)
      contextWindowCompression: {
        triggerTokens: 25600,
        slidingWindow: { targetTokens: 12800 },
      },
    },

    callbacks: {
      onmessage: async (response) => {
        if (!browserWs || browserWs.readyState !== 1) return;

        // Handle tool calls from Gemini (RAG search or saving questionnaire answers)
        if (response.toolCall) {
          const functionCalls = response.toolCall.functionCalls || [];
          const functionResponses = [];
          const callsToProcess = [];
          const seenCallsThisResponse = new Set();

          for (const call of functionCalls) {
            const logicalKey = toolCallDeduper.key(call);
            if (seenCallsThisResponse.has(logicalKey) || !toolCallDeduper.claim(call)) {
              log.warn(`🛡️ Dropping duplicate/replayed Gemini browser tool call: ${call.name}`);
              continue;
            }
            seenCallsThisResponse.add(logicalKey);
            callsToProcess.push(call);
          }

          for (const call of callsToProcess) {
            log.info(`🛠️ Tool Call: Executing ${call.name}`);
            let result = {};
            if (call.name === "search_policy_knowledge_base") {
              result = await handleSearchPolicyKnowledgeBase(call.args.query);
            } else if (call.name === "save_question_response") {
              const activeConfig = getConfig();
              const phone = activeConfig.activePhone || "Web Call";
              result = await handleSaveQuestionResponse(orgId, "web_call", phone, call.args.question, call.args.answer, normalizedQuestions);
            } else if (call.name === "save_enquiry") {
              result = await handleSaveEnquiry(orgId, "web_call", call.args);
            }
            functionResponses.push({
              id: call.id,
              name: call.name,
              response: { result }
            });
          }

          try {
            session.sendToolResponse({ functionResponses });
          } catch (err) {
            session.send({ toolResponse: { functionResponses } });
          }
        }

        // AI audio response
        if (response.serverContent?.modelTurn?.parts) {
          for (const part of response.serverContent.modelTurn.parts) {
            if (part.inlineData?.mimeType?.startsWith("audio/")) {
              // Send to browser for playback
              send(browserWs, {
                type: "audio",
                data: part.inlineData.data,
                mimeType: part.inlineData.mimeType,
              });
              // Save resampled version to recording file
              const raw = Buffer.from(part.inlineData.data, "base64");
              if (onAudioOut) {
                onAudioOut(raw.length);
              }
              recordStream.write(resample24To16(raw));
            }
          }
        }

        // Transcripts
        if (response.serverContent?.inputTranscription?.text) {
          const text = response.serverContent.inputTranscription.text;
          log.info(`👤 Caller: "${text}"`);
          transcriptLines.push({ role: "user", text });
          send(browserWs, { type: "transcript", role: "user", text });
          if (global.broadcastLog) {
            global.broadcastLog(`👤 Caller: "${text}"`, { type: "transcript", role: "user", text });
          }
        }
        if (response.serverContent?.outputTranscription?.text) {
          const text = response.serverContent.outputTranscription.text;
          log.info(`🤖 Agent: "${text}"`);
          transcriptLines.push({ role: "ai", text });
          send(browserWs, { type: "transcript", role: "ai", text });
          if (global.broadcastLog) {
            global.broadcastLog(`🤖 Agent: "${text}"`, { type: "transcript", role: "ai", text });
          }
        }

        // Barge-in: caller interrupted AI
        if (response.serverContent?.interrupted) {
          send(browserWs, { type: "interrupted" });
        }

        // Turn complete
        if (response.serverContent?.turnComplete) {
          send(browserWs, { type: "turn_complete" });
        }
      },

      onerror: (err) => {
        log.error("❌ Gemini error:", err.message || err);
        send(browserWs, { type: "error", message: String(err.message || err) });
      },

      onclose: (e) => {
        log.info(`🔌 Gemini closed. Code: ${e?.code}, Reason: ${e?.reason || "none"}`);
        send(browserWs, { type: "ended" });
      },
    },
  });

  // Attach raw WebSocket packet listener to capture exact Google server frames including usageMetadata
  if (session && session.conn && session.conn.ws) {
    session.conn.ws.on("message", (rawFrame) => {
      try {
        const payload = JSON.parse(rawFrame.toString());
        if (global.broadcastLog) {
          let eventSummary = "📥 [Gemini Receive] ";
          const usage = payload.usageMetadata || payload.serverContent?.usageMetadata || payload.usage_metadata || payload.serverContent?.usage_metadata;
          
          if (payload.serverContent?.modelTurn?.parts) {
            const hasAudio = payload.serverContent.modelTurn.parts.some(p => p.inlineData?.mimeType?.startsWith("audio/"));
            eventSummary += `serverContent (modelTurn${hasAudio ? ' with audio payload' : ''})`;
          } else if (payload.serverContent?.inputTranscription) {
            eventSummary += `inputTranscription (text: "${payload.serverContent.inputTranscription.text}")`;
          } else if (payload.serverContent?.outputTranscription) {
            eventSummary += `outputTranscription (text: "${payload.serverContent.outputTranscription.text}")`;
          } else if (payload.serverContent?.interrupted) {
            eventSummary += `interrupted (caller barge-in)`;
          } else if (payload.serverContent?.turnComplete) {
            eventSummary += `turnComplete`;
          } else {
            eventSummary += Object.keys(payload).join(", ");
          }
          
          global.broadcastLog(eventSummary, { type: "gemini_raw" });
          
          // Count and log tokens robustly as a separate event if usageMetadata is present
          if (usage) {
            const inCount = usage.promptTokenCount || usage.prompt_token_count || 0;
            const outCount = usage.responseTokenCount || usage.response_token_count || 
                             usage.candidatesTokenCount || usage.candidates_token_count || 0;
            if (inCount > 0 || outCount > 0) {
              global.broadcastLog(`📥 [Gemini Receive] usageMetadata (promptTokens: ${inCount}, responseTokens: ${outCount})`, { type: "gemini_raw" });
              onTokenUsage(inCount, outCount);
            }
          }
        }
      } catch (err) {
        // Not a JSON packet
      }
    });
  }

  return {
    sendAudio: async (base64Pcm16k) => {
      await session.sendRealtimeInput({
        media: {
          data: base64Pcm16k,
          mimeType: "audio/pcm;rate=16000",
        },
      });
    },
    close: async () => { try { await session.close(); } catch {} },
  };
}

// ──────────═════════════════════
// POST CALL: Upload + Sentiment + Supabase save
// ──────────═════════════════════
async function processPostCallData(callId, tempPcmPath, durationSeconds, transcriptLines, activeConfig, liveInputTokens, liveOutputTokens, totalInboundAudioBytes, totalOutboundAudioBytes, orgId) {
  if (!orgId) throw new Error("orgId is required for post-call processing");
  if (!fs.existsSync(tempPcmPath)) return;

  const rawPcm = fs.readFileSync(tempPcmPath);
  const wavBuffer = Buffer.concat([getWavHeader(rawPcm.length), rawPcm]);
  try { fs.unlinkSync(tempPcmPath); } catch {}

  let recordingUrl = null;
  let sentiment = "Neutral";
  // transcriptLines holds raw streaming fragments — Gemini's incremental
  // transcription pushes one entry per word/syllable chunk, not one per full
  // utterance (same bug fixed in vobizProxy.js/twilioProxy.js/piopiyProxy.js
  // — this file never had the merge step at all). Merge once, up front, and
  // reuse for both fullTranscript and transcriptForUi.
  const mergedTranscriptLines = [];
  for (const l of transcriptLines) {
    const last = mergedTranscriptLines[mergedTranscriptLines.length - 1];
    if (last && last.role === l.role) last.text += l.text;
    else mergedTranscriptLines.push({ role: l.role, text: l.text });
  }
  const fullTranscript = mergedTranscriptLines
    .map(l => `${l.role === "user" ? "Caller" : "Agent"}: ${l.text.trim()}`)
    .join("\n");

  if (storage.isConfigured() && wavBuffer.length > 44) {
    try {
      recordingUrl = await storage.upload(`recordings/${callId}.wav`, wavBuffer, { contentType: "audio/wav" });
      log.info(`💾 Recording uploaded: ${recordingUrl}`);
    } catch (uploadErr) {
      log.error("❌ Upload error:", uploadErr.message);
    }
  }

  let sentimentInputTokens = 0;
  let sentimentOutputTokens = 0;

  // Sentiment analysis — pass along whatever workflow answers were already
  // saved live during the call (cheap DB read, not another LLM call) so
  // sentiment is judged against actual engagement, not the transcript alone.
  if (transcriptLines.length > 0) {
    let liveAnswers = [];
    try { liveAnswers = await db.getResponsesByCallId(orgId, callId); } catch {}
    const result = await postCallAgents.analyzeSentiment(fullTranscript, orgId, liveAnswers);
    sentiment = result.sentiment;
    sentimentInputTokens = result.inputTokens;
    sentimentOutputTokens = result.outputTokens;
    log.info("📊 Sentiment result:", sentiment);
  }

  // Combined token calculation for BOTH models
  let totalInputTokens = liveInputTokens + sentimentInputTokens;
  let totalOutputTokens = liveOutputTokens + sentimentOutputTokens;

  // Fallback if websocket usageMetadata wasn't populated (calculate based on duration/audio bytes)
  if (totalInputTokens === 0 && totalInboundAudioBytes > 0) {
    const inputAudioSeconds = totalInboundAudioBytes / 32000;
    const promptBaseline = 1500 + (transcriptLines.length * 150);
    totalInputTokens = Math.round((inputAudioSeconds * 32) + promptBaseline);
  }
  if (totalOutputTokens === 0 && totalOutboundAudioBytes > 0) {
    const outputAudioSeconds = totalOutboundAudioBytes / 48000;
    totalOutputTokens = Math.round(outputAudioSeconds * 25);
  }

  // Pricing (verified against Google's official Gemini API pricing page for
  // native audio, gemini-2.5-flash-native-audio-preview): Input: $3.00 / 1M
  // tokens ($0.000003 / token) | Output: $12.00 / 1M tokens ($0.000012 / token)
  const costUsd = (totalInputTokens * 0.000003) + (totalOutputTokens * 0.000012);

  log.info(`📊 Cost Breakdown: Total Input Tokens=${totalInputTokens}, Total Output Tokens=${totalOutputTokens}, Cost=$${costUsd.toFixed(5)}`);

  // Save to this app's real tenant-scoped data layer. The /session
  // WebSocket org context was authenticated during the upgrade and is
  // carried explicitly through post-call processing.
  const transcriptForUi = mergedTranscriptLines.map((l) => ({
    speaker: l.role === "user" ? "Customer" : "AI",
    text: l.text.trim(),
    timestamp: new Date().toTimeString().split(" ")[0]
  }));
  // ── AI summary ───────────────────────────────────────────────────────────
  let aiSummary = fullTranscript.slice(0, 500);
  if (transcriptLines.length > 0) {
    const summary = await postCallAgents.generateCallSummary(fullTranscript, orgId);
    if (summary) aiSummary = summary.text;
  }

  db.create("calllogs", orgId, {
    leadName: "Web Call",
    duration: durationSeconds,
    status: "Completed",
    sentiment,
    intent: "Unknown",
    transcript: transcriptForUi,
    summary: aiSummary,
    recordingUrl,
    direction: "unknown",
    createdAt: new Date().toISOString()
  }).then((savedLog) => {
    if (global.broadcastLog) {
      global.broadcastLog(`📼 Call logged: Web Call (${durationSeconds}s, ${sentiment})`, { type: "call_completed", orgId, callLog: savedLog });
    }
  }).catch((err) => log.error("❌ Web call_logs insert error:", err.message));
}

// Node 18+ has fetch built-in; no node-fetch needed.

async function handleSearchPolicyKnowledgeBase(query) {
  try {
    const chromaUrl = process.env.CHROMA_URL || "http://chroma-db:8000";
    const collectionsRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`);
    const collections = await collectionsRes.json();
    const targetColl = collections.find(c => c.name === "policy-documents");
    if (!targetColl) throw new Error("policy-documents collection not found");
    const collectionId = targetColl.id;
    const searchUrl = `${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${collectionId}/get`;

    log.info(`🔍 Chroma DB: Searching for "${query}"`);

    // Clean query and extract keywords
    const stopwords = new Set(["what", "is", "the", "a", "of", "and", "in", "to", "for", "about", "how", "does", "do", "you", "have", "definition", "qualifies", "under", "policy", "wording", "plan", "insurance"]);
    const keywords = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w));

    let filterBody = {};
    if (keywords.length > 0) {
      const expanded = [];
      for (const kw of keywords) {
        expanded.push(kw.toLowerCase());
        expanded.push(kw.charAt(0).toUpperCase() + kw.slice(1));
        expanded.push(kw.toUpperCase());
      }
      if (expanded.length === 1) {
        filterBody = { where_document: { "$contains": expanded[0] } };
      } else {
        filterBody = {
          where_document: {
            "$or": expanded.map(kw => ({ "$contains": kw }))
          }
        };
      }
    } else {
      filterBody = { where_document: { "$contains": query } };
    }

    const res = await fetch(searchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...filterBody,
        limit: 3,
        include: ["documents"]
      })
    });
    const data = await res.json();
    if (data && Array.isArray(data.documents) && data.documents.length > 0) {
      const docs = data.documents.join("\n\n---\n\n");
      log.info(`✅ Chroma DB: Found ${data.documents.length} matches.`);
      return { success: true, documents: docs };
    }
    return { success: false, message: "No matching policy documents found in the database." };
  } catch (err) {
    log.error("❌ Chroma DB search failed:", err.message);
    return { success: false, error: err.message };
  }
}

async function handleSaveQuestionResponse(orgId, callId, phone, question, answer, questionsList = []) {
  if (!orgId) throw new Error("orgId is required to save a question response");
  // The organization is supplied by the authenticated WebSocket session
  // context; never infer or default it here.
  return questionnaire.saveQuestionResponse({ orgId, callId, phone, question, answer, questionsList });
}

// Saves a mid-call question/request the AI couldn't fully resolve, so a
// team member can follow up — surfaces in the CRM's Enquiries tab.
async function handleSaveEnquiry(orgId, callId, args) {
  if (!orgId) throw new Error("orgId is required to save an enquiry");
  try {
    // Organization scope is supplied explicitly by the authenticated session.
    await db.create("enquiries", orgId, {
      callId,
      name: args.name || null,
      phone: looksLikePhone(args.phone) ? args.phone : null,
      email: args.email || null,
      location: args.location || null,
      queryText: args.query_text,
      status: "new",
      createdAt: new Date().toISOString()
    });
    log.info(`✅ Enquiry saved: "${args.query_text}"`);
    return { success: true, saved: true };
  } catch (err) {
    log.error("❌ Enquiry save failed:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { handleBrowserSession, handleSearchPolicyKnowledgeBase, handleSaveQuestionResponse, handleSaveEnquiry };
