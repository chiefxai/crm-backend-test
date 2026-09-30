const { createVobizOutboundAudioPlayer } = require("../../src/telephony/vobizOutboundAudio");

describe("vobizOutboundAudio recording hook", () => {
  it("records PCM when setWriteRecording is attached after player creation", () => {
    const chunks = [];
    const player = createVobizOutboundAudioPlayer(null, () => "stream-1", { callId: "test" });
    player.setWriteRecording((buf) => chunks.push(buf));
    const pcm = Buffer.alloc(640, 1);
    player.enqueuePcm(pcm);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(pcm);
  });
});
