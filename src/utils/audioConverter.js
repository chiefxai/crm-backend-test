// services/audioConverter.js
// ============================================================
// Low-overhead audio translation for G.711 mu-law <-> PCM16
// and sample-rate conversions (8kHz <-> 16kHz <-> 24kHz)
// ============================================================

const alawmulaw = require("alawmulaw");

/**
 * Decodes 8kHz G.711 mu-law (Twilio inbound) to 8kHz 16-bit linear PCM
 * @param {Buffer} mulawBuffer 
 * @returns {Buffer} pcmBuffer
 */
function mulawToPcm16(mulawBuffer) {
  const uint8Samples = new Uint8Array(mulawBuffer);
  const decoded16 = alawmulaw.mulaw.decode(uint8Samples);
  return Buffer.from(decoded16.buffer, decoded16.byteOffset, decoded16.byteLength);
}

/**
 * Encodes 8kHz 16-bit linear PCM to 8kHz G.711 mu-law (Twilio outbound)
 * @param {Buffer} pcmBuffer 
 * @returns {Buffer} mulawBuffer
 */
function pcm16ToMulaw(pcmBuffer) {
  const aligned = new Uint8Array(pcmBuffer.length);
  aligned.set(pcmBuffer);
  const int16Samples = new Int16Array(
    aligned.buffer, 
    aligned.byteOffset, 
    Math.floor(aligned.length / 2)
  );
  const encoded8 = alawmulaw.mulaw.encode(int16Samples);
  return Buffer.from(encoded8.buffer, encoded8.byteOffset, encoded8.byteLength);
}

/**
 * Upsamples 16-bit PCM from 8kHz to 16kHz (for Gemini input)
 * Duplicates each sample (Zero-Order Hold / Linear Interpolation)
 * @param {Buffer} pcm8k 
 * @returns {Buffer} pcm16k
 */
function upsample8To16(pcm8k) {
  const samples8k = pcm8k.length / 2;
  const pcm16k = Buffer.alloc(pcm8k.length * 2);
  for (let i = 0; i < samples8k; i++) {
    const sample = pcm8k.readInt16LE(i * 2);
    pcm16k.writeInt16LE(sample, i * 4);
    pcm16k.writeInt16LE(sample, i * 4 + 2);
  }
  return pcm16k;
}

/**
 * Downsamples 16-bit PCM from 24kHz to 8kHz (for Twilio outbound)
 * Keeps 1 out of every 3 samples
 * @param {Buffer} pcm24k 
 * @returns {Buffer} pcm8k
 */
function downsample24To8(pcm24k) {
  const samples24k = pcm24k.length / 2;
  const samples8k = Math.floor(samples24k / 3);
  const pcm8k = Buffer.alloc(samples8k * 2);
  for (let i = 0; i < samples8k; i++) {
    const sample = pcm24k.readInt16LE(i * 6);
    pcm8k.writeInt16LE(sample, i * 2);
  }
  return pcm8k;
}

/**
 * Downsamples 16-bit PCM from 16kHz to 8kHz
 * Keeps 1 out of every 2 samples
 * @param {Buffer} pcm16k 
 * @returns {Buffer} pcm8k
 */
function downsample16To8(pcm16k) {
  const samples16k = pcm16k.length / 2;
  const samples8k = Math.floor(samples16k / 2);
  const pcm8k = Buffer.alloc(samples8k * 2);
  for (let i = 0; i < samples8k; i++) {
    const sample = pcm16k.readInt16LE(i * 4);
    pcm8k.writeInt16LE(sample, i * 2);
  }
  return pcm8k;
}

/**
 * Stateful 24kHz -> 8kHz decimator (keep 1 of every 3 samples), for
 * streaming Gemini's audio output to Twilio/PIOPIY one small inlineData
 * chunk at a time. The plain downsample24To8 above resets to sample
 * position 0 on every call, so every chunk boundary silently truncated
 * a 1-2 sample tail that belonged to the same continuous decimation
 * cycle (`Math.floor(samples24k / 3)`), and never carried an odd
 * trailing byte (half a sample) into the next chunk either — with
 * Gemini streaming audio in many small pieces per turn (one per word/
 * phrase, not one buffer per response), that's a real discontinuity at
 * every single chunk boundary, which is exactly what a caller hears as
 * clicking/choppy speech even though the pacing queue downstream plays
 * the (already-glitched) bytes out smoothly. Call this once per call
 * (not per chunk, not shared across calls) and keep reusing the same
 * returned function for every inlineData chunk of that call.
 * @returns {(pcm24k: Buffer) => Buffer}
 */
function createDownsampler24To8() {
  let oddByte = null; // a trailing single byte (half a sample) carried from the previous chunk
  let phase = 0;      // how many samples into the current keep-1-of-3 cycle we are, carried across chunks

  return function downsample(pcm24kChunk) {
    let buf = pcm24kChunk;
    if (oddByte) {
      buf = Buffer.concat([oddByte, buf]);
      oddByte = null;
    }
    if (buf.length % 2 !== 0) {
      oddByte = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    }
    const aligned = new Uint8Array(buf.length);
    aligned.set(buf);
    const samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);

    const kept = [];
    for (let i = 0; i < samples.length; i++) {
      if (phase === 0) kept.push(samples[i]);
      phase = (phase + 1) % 3;
    }
    const out = new Int16Array(kept);
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  };
}

/**
 * Stateful 24kHz -> 16kHz linear-interpolation resampler, for streaming
 * Gemini's audio output to Vobiz one small inlineData chunk at a time.
 * Same reasoning as createDownsampler24To8 above: a plain per-chunk
 * resample restarts its interpolation position at 0 on every call, so
 * the LAST output sample of each chunk always interpolates against
 * itself (clamped to the chunk's own final sample) instead of the real
 * next sample, which actually arrives in the FOLLOWING chunk — a small
 * but audible step at every chunk boundary. This carries the
 * fractional interpolation position and the not-yet-consumed trailing
 * samples forward so the output is identical to resampling one
 * continuous stream, regardless of how it was chunked on the way in.
 * @returns {(pcm24k: Buffer) => Buffer}
 */
function parsePcmSampleRateFromMime(mimeType, fallback = 24000) {
  const m = String(mimeType || "").match(/rate=(\d+)/i);
  if (!m) return fallback;
  const rate = parseInt(m[1], 10);
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

function resample24To16Linear(buffer24) {
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

/**
 * Normalize Gemini TTS / PCM blobs to 16 kHz mono PCM16 for Vobiz playAudio.
 * @param {Buffer} pcmBuffer
 * @param {number} sourceSampleRate
 */
function pcmToTelephony16k(pcmBuffer, sourceSampleRate = 24000) {
  const rate = sourceSampleRate || 24000;
  if (!pcmBuffer?.length) return pcmBuffer;
  if (rate === 16000) return pcmBuffer;
  if (rate === 24000) return resample24To16Linear(pcmBuffer);
  const aligned = new Uint8Array(pcmBuffer.length);
  aligned.set(pcmBuffer);
  const src = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
  const ratio = 16000 / rate;
  const outLen = Math.max(1, Math.round(src.length * ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(src.length - 1, lo + 1);
    const frac = pos - lo;
    out[i] = src[lo] * (1 - frac) + src[hi] * frac;
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Time-compress or expand 16 kHz PCM (factor > 1 = faster speech, < 1 = slower).
 * @param {Buffer} pcm16k
 * @param {number} factor
 */
function adjustPcm16PlaybackRate(pcm16k, factor) {
  if (!pcm16k?.length || !factor || Math.abs(factor - 1) < 0.02) return pcm16k;
  const aligned = new Uint8Array(pcm16k.length);
  aligned.set(pcm16k);
  const src = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
  const outLen = Math.max(1, Math.round(src.length / factor));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * factor;
    const lo = Math.floor(pos);
    const hi = Math.min(src.length - 1, lo + 1);
    const frac = pos - lo;
    out[i] = src[lo] * (1 - frac) + src[hi] * frac;
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function createResampler24To16() {
  let carry = new Int16Array(0); // unconsumed trailing samples from the previous chunk, needed to interpolate the start of this one
  let phase = 0;                 // fractional position into `carry`/the new chunk where the next output sample starts
  let oddByte = null;

  return function resample(pcm24kChunk) {
    let buf = pcm24kChunk;
    if (oddByte) {
      buf = Buffer.concat([oddByte, buf]);
      oddByte = null;
    }
    if (buf.length % 2 !== 0) {
      oddByte = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    }
    const aligned = new Uint8Array(buf.length);
    aligned.set(buf);
    const newSamples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);

    const full = new Int16Array(carry.length + newSamples.length);
    full.set(carry, 0);
    full.set(newSamples, carry.length);

    const out = [];
    let pos = phase;
    while (true) {
      const lo = Math.floor(pos);
      const hi = lo + 1;
      if (hi >= full.length) break; // not enough data yet to interpolate this sample — wait for the next chunk
      const frac = pos - lo;
      out.push(full[lo] * (1 - frac) + full[hi] * frac);
      pos += 1.5;
    }
    const carryStart = Math.max(0, Math.floor(pos));
    carry = full.slice(carryStart);
    phase = pos - carryStart;

    const outArr = new Int16Array(out);
    return Buffer.from(outArr.buffer, outArr.byteOffset, outArr.byteLength);
  };
}

module.exports = {
  mulawToPcm16,
  pcm16ToMulaw,
  upsample8To16,
  downsample24To8,
  downsample16To8,
  parsePcmSampleRateFromMime,
  resample24To16Linear,
  pcmToTelephony16k,
  adjustPcm16PlaybackRate,
  createDownsampler24To8,
  createResampler24To16
};
