const assert = require("assert");
const { createCallRecorder, createWavHeader } = require("../../src/telephony/recording/manager");

function pcm(samples, value) {
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) out.writeInt16LE(value, i * 2);
  return out;
}

describe("recording manager frame ordering", () => {
  it("does not overlap consecutive frames when delivery is bursty", async () => {
    let uploaded = null;
    const recorder = createCallRecorder({
      provider: "test",
      callId: "burst-test",
      mode: "platform",
      uploadPlatformRecording: async (wav) => {
        uploaded = wav;
        return "s3://test/burst.wav";
      },
    });

    await recorder.start();
    recorder.write(pcm(320, 1000), { track: "caller" });
    recorder.write(pcm(320, 2000), { track: "caller" });

    const result = await recorder.finalize();

    assert.strictEqual(result.url, "s3://test/burst.wav");
    assert.ok(uploaded);
    assert.strictEqual(uploaded.subarray(0, 4).toString(), "RIFF");
    assert.strictEqual(uploaded.length, 44 + 640 * 2);

    assert.strictEqual(uploaded.readInt16LE(44), 1000);
    assert.strictEqual(uploaded.readInt16LE(44 + 640), 2000);
  });

  it("keeps single-sided inbound audio at full volume", async () => {
    let uploaded = null;
    const recorder = createCallRecorder({
      provider: "test",
      callId: "inbound-test",
      mode: "platform",
      uploadPlatformRecording: async (wav) => {
        uploaded = wav;
        return "s3://test/inbound.wav";
      },
    });

    await recorder.start();
    recorder.write(pcm(320, 1200), { track: "caller" });

    await recorder.finalize();

    assert.ok(uploaded);
    assert.strictEqual(uploaded.readInt16LE(44), 1200);
  });
});
