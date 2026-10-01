// Vobiz transport adapter for the shared telephony audio pipeline.
const { createOutboundAudioPlayer, DEFAULT_PREBUFFER_BYTES } = require("../media/audioPipeline");
function createVobizOutboundAudioPlayer(vobizWs, getStreamId, { writeRecording, callId = "unknown" } = {}) {
  let currentWs = vobizWs;
  const player = createOutboundAudioPlayer({
    callId, writeRecording, prebufferBytes: DEFAULT_PREBUFFER_BYTES, loggerName: "telephony.vobizOutboundAudio",
    sendFrame(chunk) {
      if (!currentWs || currentWs.readyState !== 1) return false;
      currentWs.send(JSON.stringify({ event: "playAudio", media: { contentType: "audio/x-l16", sampleRate: 16000, payload: chunk.toString("base64") } }));
      return true;
    },
  });
  return { ...player, setWebSocket(ws) { currentWs = ws; } };
}
module.exports = { createVobizOutboundAudioPlayer, PREBUFFER_BYTES: DEFAULT_PREBUFFER_BYTES };