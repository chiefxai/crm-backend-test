// services/vobizPipelineCascaded.js
// ============================================================
// EXPERIMENTAL — latency comparison only, not feature-complete.
//
// Same Vobiz telephony transport as vobizProxy.js, but instead of Gemini
// Live's single native-audio model, this cascades three separate calls:
// Google Cloud Speech-to-Text (streaming) -> Gemini text model -> Gemini
// TTS (same voice model/family as the production native-audio pipeline,
// e.g. "Achird" — a caller comparing the two calls should hear the same
// voice and speaking style, only the pipeline shape differs). Several
// competitors (Bolna, ZenXAI, most of the Indian voice-AI market per
// public research) use this STT+LLM+TTS shape and claim sub-1s latency;
// our native-audio pipeline measured 588ms-1991ms. First real test came
// back slower (1739-2255ms) AND with caller-reported clarity complaints
// when using a generic Google Cloud TTS voice — this swap to Gemini TTS
// addresses the voice/style mismatch; latency is still expected to be
// similar or worse since this remains a non-streaming synthesis call.
//
// Deliberately NOT wired into production traffic by default — see the
// CASCADED_PIPELINE_TEST_NUMBER gate in server.js's /api/vobiz/incoming.
// No tool-calling, no knowledge base, no CRM writes, no reconnect/resume
// logic — just greeting + a conversational loop with the same latency
// instrumentation as vobizProxy.js's "DEBUG: latency" log, so the two
// numbers are directly comparable.
// ============================================================

const speech = require("@google-cloud/speech");
const genai = require("../../ai/googleAiClient");
const { getLogger } = require("../../observability/logger");
const log = getLogger("telephony.vobizPipelineCascaded");

const KEY_FILE = process.env.CASCADED_STT_TTS_KEYFILE || "./secrets/cascaded-voice-test-key.json";
const sttClient = new speech.SpeechClient({ keyFilename: KEY_FILE });

// Same voice used by default in vobizProxy.js's VOICE_MAP, so a caller
// comparing the two pipelines hears the same voice/style, isolating the
// comparison to pipeline architecture rather than voice choice.
const TTS_VOICE_NAME = "Achird";

function sendJson(wsConn, obj) {
  if (wsConn.readyState === 1) wsConn.send(JSON.stringify(obj));
}

// Same linear-interpolation resample used in vobizProxy.js, duplicated
// here rather than exported/shared since this whole module is a
// throwaway experiment, not a permanent addition to the shared pipeline.
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

async function synthesizeAndQueue(text, outboundQueue, startPacing) {
  const response = await aiClient.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE_NAME } } }
    }
  });
  const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error("Gemini TTS returned no audio (finishReason: " + response.candidates?.[0]?.finishReason + ")");
  const raw24k = Buffer.from(part.inlineData.data, "base64");
  const pcm16k = resample24To16(raw24k);
  for (let i = 0; i < pcm16k.length; i++) outboundQueue.push(pcm16k[i]);
  startPacing();
}

async function handleVobizSessionCascaded(vobizWs, streamContext = null) {
  const orgId = streamContext?.orgId ? String(streamContext.orgId) : null;
  const authorizedCallId = streamContext?.callId ? String(streamContext.callId) : null;
  if (!orgId || !authorizedCallId) throw new Error("Vobiz stream authorization context is required");
  let isActive = true;
  const aiClient = await genai.getClientForOrg(orgId);
  let streamId = null;
  let systemPrompt = "You are a helpful voice assistant for a health insurance company. Keep replies short, 1-2 sentences, natural spoken Tamil/English (Tanglish) mix.";

  const outboundQueue = [];
  let intervalId = null;
  const PREBUFFER_BYTES = 2560; // 80ms of 16kHz PCM16, matches vobizProxy.js
  let hasPrebuffered = false;

  const startPacing = () => {
    if (intervalId) return;
    intervalId = setInterval(() => {
      if (!hasPrebuffered) {
        if (outboundQueue.length < PREBUFFER_BYTES) return;
        hasPrebuffered = true;
      }
      if (outboundQueue.length >= 640) {
        const chunk = Buffer.from(outboundQueue.splice(0, 640));
        sendJson(vobizWs, {
          event: "playAudio",
          media: { contentType: "audio/x-l16", sampleRate: 16000, payload: chunk.toString("base64") }
        });
      }
    }, 20);
  };

  const stopPacing = () => {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    outboundQueue.length = 0;
    hasPrebuffered = false;
  };

  // Conversation history for the text-only Gemini call — kept minimal
  // (no tools, no knowledge base) since this is a latency test, not a
  // feature-parity rebuild.
  const history = [];
  let lastCallerSpeechAt = null;

  const handleFinalTranscript = async (text) => {
    if (!text || !text.trim()) return;
    lastCallerSpeechAt = Date.now();
    log.info(`👤 [Cascaded] Vobiz Caller: "${text}"`);
    history.push({ role: "user", parts: [{ text }] });

    let reply;
    try {
      const result = await aiClient.models.generateContent({
        model: "gemini-2.5-flash",
        contents: history,
        config: { systemInstruction: { parts: [{ text: systemPrompt }] }, maxOutputTokens: 120, temperature: 0.9 }
      });
      reply = result.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
    } catch (err) {
      log.error("❌ [Cascaded] Gemini text call failed:", err.message);
      return;
    }
    if (!reply) return;
    history.push({ role: "model", parts: [{ text: reply }] });
    log.info(`🤖 [Cascaded] Agent to Vobiz: "${reply}"`);

    try {
      await synthesizeAndQueue(reply, outboundQueue, startPacing);
      log.info(`⏱️ [Cascaded] DEBUG: latency from last caller speech to first agent reply: ${Date.now() - lastCallerSpeechAt}ms`);
    } catch (err) {
      log.error("❌ [Cascaded] TTS synth failed:", err.message);
    }
  };

  // Google Cloud streaming STT — one persistent recognizeStream for the
  // whole call, fed raw inbound PCM as it arrives. isFinal segments are
  // treated the same way vobizProxy.js treats a finished inputTranscription
  // fragment: as "the caller just said this."
  let recognizeStream = null;
  const startRecognizeStream = () => {
    recognizeStream = sttClient
      .streamingRecognize({
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
          languageCode: "ta-IN",
          alternativeLanguageCodes: ["en-IN"],
          model: "latest_long"
        },
        interimResults: false
      })
      .on("error", (err) => log.error("❌ [Cascaded] STT stream error:", err.message))
      .on("data", (data) => {
        const result = data.results?.[0];
        if (result?.isFinal) {
          const transcript = result.alternatives?.[0]?.transcript || "";
          handleFinalTranscript(transcript);
        }
      });
  };

  vobizWs.on("message", async (rawMsg) => {
    if (!isActive) return;
    let msg;
    try { msg = JSON.parse(rawMsg.toString()); } catch (_) { return; }

    switch (msg.event) {
      case "start": {
        streamId = msg.start?.streamId || msg.streamId;
        const callId = msg.start?.callId || msg.callId;
        if (!callId || String(callId) !== authorizedCallId) {
          log.error(`🚫 [Cascaded] Vobiz call authorization mismatch: token=${authorizedCallId} start=${callId || "missing"}`);
          isActive = false;
          try { vobizWs.close(1008, "Call authorization mismatch"); } catch {}
          return;
        }
        log.info(`✅ [Cascaded] Vobiz Stream started: ${streamId}`);
        startRecognizeStream();
        const greeting = "Vanakkam! Naanga ChiefX Insurance-la irundhu call panrom. Ungaluku ippo konjam neram pesalama?";
        history.push({ role: "model", parts: [{ text: greeting }] });
        try {
          await synthesizeAndQueue(greeting, outboundQueue, startPacing);
        } catch (err) {
          log.error("❌ [Cascaded] Greeting TTS failed:", err.message);
        }
        break;
      }

      case "media":
        if (msg.media.track === "inbound" && recognizeStream && !recognizeStream.destroyed) {
          const rawPCM = Buffer.from(msg.media.payload, "base64");
          recognizeStream.write(rawPCM);
        }
        break;

      case "stop":
        log.info(`🔌 [Cascaded] Vobiz Stream stopped: ${streamId}`);
        isActive = false;
        stopPacing();
        try { recognizeStream?.end(); } catch (_) {}
        break;
    }
  });

  vobizWs.on("close", () => {
    isActive = false;
    stopPacing();
    try { recognizeStream?.end(); } catch (_) {}
    log.info(`🌐 [Cascaded] Vobiz WS closed`);
  });

  vobizWs.on("error", (err) => {
    log.error("❌ [Cascaded] Vobiz WS error:", err.message);
  });
}

module.exports = { handleVobizSessionCascaded };
