const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCallRecorder, RECORDING_MODES } = require("../src/telephony/recording/manager");

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chiefvoice-recording-"));
  let uploaded = null;

  const recorder = createCallRecorder({
    provider: "test",
    callId: "call-test-1",
    mode: RECORDING_MODES.AUTO,
    tempDir,
    uploadPlatformRecording: async (wav, callId) => {
      uploaded = { wav, callId };
      return "s3://test/call-test-1.wav";
    },
  });

  await recorder.start();
  assert.equal(recorder.getMode(), RECORDING_MODES.PLATFORM);
  recorder.write(Buffer.alloc(320));
  const result = await recorder.finalize();

  assert.equal(result.source, "platform");
  assert.equal(result.url, "s3://test/call-test-1.wav");
  assert.equal(uploaded.callId, "call-test-1");
  assert.equal(uploaded.wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(fs.readdirSync(tempDir).length, 0);

  const disabled = createCallRecorder({
    provider: "test",
    callId: "call-test-2",
    mode: RECORDING_MODES.DISABLED,
    tempDir,
  });
  await disabled.start();
  assert.equal(disabled.getMode(), RECORDING_MODES.DISABLED);
  assert.equal(disabled.write(Buffer.alloc(320)), false);
  assert.equal((await disabled.finalize()).source, "disabled");

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("recording manager tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
