/**
 * Shared primitives for Twilio Media Streams transports.
 *
 * Used by:
 *  - {@link PipecatAgentAdapter} — Pipecat bots configured with the
 *    `-t twilio` transport speak Twilio Media Streams JSON on their WS;
 *    scenario impersonates Twilio.
 *  - The Twilio adapter that ships in a follow-up PR — it speaks the same
 *    protocol against the real Twilio bridge.
 *
 * Contents:
 *  - g711 µ-law 8kHz ↔ PCM16 24kHz codec. Twilio Media Streams always
 *    uses µ-law 8kHz mono; our canonical internal format is PCM16 24kHz
 *    mono (see {@link AudioChunk}). Adapters convert at the wire edge so
 *    the N adapters × M formats matrix collapses to N edge conversions.
 *  - Media Streams WebSocket frame parser/serializer (the JSON schema
 *    Twilio emits at `wss://.../twilio/stream`).
 *
 * Python parity: `python/scenario/voice/adapters/_twilio_shared.py`. The
 * codec helpers mirror `audioop.{ulaw2lin, lin2ulaw, ratecv}` since Node
 * has no built-in equivalent — the math is the load-bearing part.
 */

import { Buffer } from "node:buffer";

import { PCM16_SAMPLE_RATE } from "../audio-chunk";

/** Twilio Media Streams always uses µ-law 8kHz mono. */
export const TWILIO_SAMPLE_RATE = 8000;
/** PCM16 little-endian = 2 bytes per sample. */
export const PCM16_SAMPLE_WIDTH_BYTES = 2;
/** Twilio Media Streams delivers audio in 20ms frames. */
export const TWILIO_FRAME_MS = 20;
/** 20ms of µ-law 8kHz mono = 160 bytes. */
export const TWILIO_FRAME_BYTES = (TWILIO_SAMPLE_RATE * TWILIO_FRAME_MS) / 1000;

// ---------------------------------------------------------------- g711 µ-law codec

/**
 * G.711 µ-law encode bias. The G.711 spec adds 0x84 to the magnitude
 * before segment encoding so a zero PCM input maps to a non-zero µ-law
 * byte (per the standard's silent-suppression behavior).
 */
const MULAW_BIAS = 0x84;
/** µ-law clip threshold — magnitudes above this saturate to the top segment. */
const MULAW_CLIP = 32635;

/**
 * Encode one PCM16 sample (-32768..32767) to one µ-law byte (G.711).
 *
 * Direct port of the ITU-T G.711 reference encode formula. Sign is
 * captured in the high bit of the output byte; magnitude is segmented
 * into 8 logarithmic regions of 16 codes each. Output is XORed with 0xff
 * so silent input encodes to 0xff (per the spec's "complemented" form
 * used by every real-world µ-law system, including Twilio).
 */
function mulawEncodeSample(pcm: number): number {
  let sign = 0;
  let sample = pcm;
  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  // Find the segment: floor(log2(sample >> 7)).
  let segment = 0;
  for (let s = sample >> 7; s >= 2; s >>= 1) segment++;
  if (segment > 7) segment = 7;

  const quant = (sample >> (segment + 3)) & 0x0f;
  return (~(sign | (segment << 4) | quant)) & 0xff;
}

/**
 * Decode one µ-law byte (G.711) to one PCM16 sample.
 *
 * Direct port of the ITU-T G.711 reference decode formula. Reverses the
 * encode: complement the byte, split off sign/segment/quant, expand to
 * 14-bit magnitude (rebiased), shift up to 16-bit PCM, apply sign.
 */
function mulawDecodeSample(byte: number): number {
  const inverted = (~byte) & 0xff;
  const sign = inverted & 0x80;
  const segment = (inverted >> 4) & 0x07;
  const quant = inverted & 0x0f;
  // Expand: position the quant bits in the segment-dependent magnitude
  // window, set the segment's implicit "1" bit, rebias, and rescale.
  let magnitude = ((quant << 3) | 0x84) << segment;
  magnitude -= MULAW_BIAS;
  return sign ? -magnitude : magnitude;
}

/**
 * Decode a µ-law 8kHz byte stream to PCM16 8kHz little-endian bytes.
 * Internal — exported for testing. Sample-rate conversion is a separate
 * step ({@link resamplePcm16}).
 */
export function mulawToPcm16(mulaw: Uint8Array): Uint8Array {
  const out = new Uint8Array(mulaw.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < mulaw.length; i++) {
    view.setInt16(i * 2, mulawDecodeSample(mulaw[i] ?? 0), true);
  }
  return out;
}

/**
 * Encode PCM16 8kHz little-endian bytes to a µ-law 8kHz byte stream.
 * Internal — exported for testing. Sample-rate conversion is a separate
 * step ({@link resamplePcm16}).
 */
export function pcm16ToMulaw(pcm: Uint8Array): Uint8Array {
  const numSamples = Math.floor(pcm.length / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Uint8Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    out[i] = mulawEncodeSample(view.getInt16(i * 2, true));
  }
  return out;
}

/**
 * Linear-interpolation resampler for mono PCM16 little-endian bytes.
 *
 * Mirrors Python `audioop.ratecv(..., state=None)` for a single batch:
 * stateless linear interpolation between adjacent input samples. Good
 * enough for the round-trip fidelity Twilio Media Streams already
 * tolerates (8 kHz µ-law loses high-band content; resampling math
 * doesn't move the needle on quality).
 *
 * Exposed for tests; production callers should use the named helpers
 * below.
 */
export function resamplePcm16(
  pcm: Uint8Array,
  fromRate: number,
  toRate: number,
): Uint8Array {
  if (pcm.length === 0 || fromRate === toRate) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  if (inSamples === 0) return new Uint8Array(0);

  const inView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  // Use Math.round for output length so 8k→24k of N samples gives ~3N out,
  // and 24k→8k of 3N gives ~N out (matches what callers expect downstream).
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = new Uint8Array(outSamples * 2);
  const outView = new DataView(out.buffer);
  const ratio = fromRate / toRate;

  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = srcPos - i0;
    const s0 = inView.getInt16(i0 * 2, true);
    const s1 = inView.getInt16(i1 * 2, true);
    const interp = Math.round(s0 + (s1 - s0) * frac);
    // Clamp to int16; round() of in-range floats stays in range, but guard
    // anyway against accumulated rounding error on edge cases.
    const clamped = interp > 32767 ? 32767 : interp < -32768 ? -32768 : interp;
    outView.setInt16(i * 2, clamped, true);
  }
  return out;
}

/** Decode µ-law 8kHz mono → PCM16 24kHz mono. */
export function mulaw8kToPcm16At24k(mulaw: Uint8Array): Uint8Array {
  if (mulaw.length === 0) return new Uint8Array(0);
  const pcm8k = mulawToPcm16(mulaw);
  return resamplePcm16(pcm8k, TWILIO_SAMPLE_RATE, PCM16_SAMPLE_RATE);
}

/** Encode PCM16 24kHz mono → µ-law 8kHz mono. */
export function pcm16At24kToMulaw8k(pcm: Uint8Array): Uint8Array {
  if (pcm.length === 0) return new Uint8Array(0);
  const pcm8k = resamplePcm16(pcm, PCM16_SAMPLE_RATE, TWILIO_SAMPLE_RATE);
  return pcm16ToMulaw(pcm8k);
}

/**
 * Split a µ-law buffer into 20ms (160-byte) frames for Media Streams.
 * The final frame may be short if the input isn't a multiple of 160; the
 * adapter drops short frames upstream (see {@link PipecatAgentAdapter}).
 */
export function* iterMulawFrames(mulaw: Uint8Array): Generator<Uint8Array> {
  for (let i = 0; i < mulaw.length; i += TWILIO_FRAME_BYTES) {
    yield mulaw.subarray(i, Math.min(i + TWILIO_FRAME_BYTES, mulaw.length));
  }
}

// ---------------------------------------------------------------- frame protocol

/** Parsed Twilio Media Streams event. */
export interface MediaStreamEvent {
  event: "connected" | "start" | "media" | "stop" | "dtmf" | "mark";
  streamSid?: string;
  callSid?: string;
  /** Decoded µ-law payload for `media` events. */
  payloadMulaw?: Uint8Array;
  dtmfDigit?: string;
  markName?: string;
}

/**
 * Parse a JSON frame received from Twilio Media Streams. Returns null
 * for events we don't recognize so callers can skip silently — Twilio
 * occasionally adds new event types and we don't want unknown-event
 * shapes to crash the receive loop.
 */
export function parseMediaStreamFrame(text: string): MediaStreamEvent | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const event = data.event;
  if (typeof event !== "string") return null;

  const start = (data.start ?? {}) as Record<string, unknown>;
  const streamSid =
    (data.streamSid as string | undefined) ?? (start.streamSid as string | undefined);
  const callSid = start.callSid as string | undefined;

  if (event === "media") {
    const media = (data.media ?? {}) as Record<string, unknown>;
    const b64 = media.payload;
    if (typeof b64 !== "string") return null;
    let payload: Uint8Array;
    try {
      payload = new Uint8Array(Buffer.from(b64, "base64"));
    } catch {
      return null;
    }
    return { event: "media", streamSid, callSid, payloadMulaw: payload };
  }

  if (event === "dtmf") {
    const dtmf = (data.dtmf ?? {}) as Record<string, unknown>;
    const digit = dtmf.digit;
    if (typeof digit !== "string") return null;
    return { event: "dtmf", streamSid, dtmfDigit: digit };
  }

  if (event === "mark") {
    const mark = (data.mark ?? {}) as Record<string, unknown>;
    const name = mark.name;
    return {
      event: "mark",
      streamSid,
      markName: typeof name === "string" ? name : undefined,
    };
  }

  if (event === "connected" || event === "start" || event === "stop") {
    return { event, streamSid, callSid };
  }

  return null;
}

/** Build an outbound `media` JSON frame for Twilio Media Streams. */
export function buildMediaFrame(streamSid: string, mulawPayload: Uint8Array): string {
  return JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: Buffer.from(mulawPayload).toString("base64") },
  });
}

/**
 * Build an outbound `clear` frame — tells the receiver to drop buffered
 * audio. Used for interruption: when the user starts talking while the
 * agent is mid-utterance, `clear` stops in-flight TTS playback.
 */
export function buildClearFrame(streamSid: string): string {
  return JSON.stringify({ event: "clear", streamSid });
}

/**
 * Build an outbound `mark` frame — a named marker in the audio stream.
 * Cooperating receivers echo the mark back once the audio that preceded
 * it has been played out. Used as an explicit end-of-turn signal so SUTs
 * don't have to guess via VAD timing.
 */
export function buildMarkFrame(streamSid: string, name: string): string {
  return JSON.stringify({ event: "mark", streamSid, mark: { name } });
}
