/**
 * Shared primitives for Twilio Media Streams transports.
 *
 * Used by:
 *  - {@link PipecatAgentAdapter} — Pipecat bots configured with the
 *    `-t twilio` transport speak Twilio Media Streams JSON on their WS;
 *    scenario impersonates Twilio.
 *  - {@link TwilioAgentAdapter} + {@link TwilioWebhookServer} — speak the
 *    same protocol against the real Twilio bridge, and additionally use the
 *    REST client + `X-Twilio-Signature` validation here.
 *
 * Contents:
 *  - g711 µ-law 8kHz ↔ PCM16 24kHz codec. Twilio Media Streams always uses
 *    µ-law 8kHz mono; our canonical internal format is PCM16 24kHz mono (see
 *    {@link AudioChunk}). Adapters convert at the wire edge so the
 *    N adapters × M formats matrix collapses to N edge conversions.
 *  - Media Streams WebSocket frame parser/serializer (the JSON schema Twilio
 *    emits at `wss://.../twilio/stream`).
 *  - E.164 / DTMF validation, a minimal `fetch`-based REST client, and
 *    `X-Twilio-Signature` verification (Twilio telephony only).
 *
 * Not exported from `voice/index.ts`. Internal to the adapter module.
 *
 * Python parity: `python/scenario/voice/adapters/_twilio_shared.py`. The codec
 * helpers mirror `audioop.{ulaw2lin, lin2ulaw, ratecv}` since Node has no
 * built-in equivalent — the math is the load-bearing part.
 *
 * Codec function naming: the canonical names are {@link mulaw8kToPcm16At24k}
 * and {@link pcm16At24kToMulaw8k}. The `*_24k` names ({@link mulaw8kToPcm16_24k},
 * {@link pcm16_24kToMulaw8k}) are kept as aliases of the canonical pair so the
 * Twilio trio (twilio.ts / twilio-server.ts) and the pipecat adapter can each
 * keep their existing call sites. One implementation; two exported names.
 */

import { Buffer } from "node:buffer";

import { PCM16_SAMPLE_RATE } from "../audio-chunk";

/** Twilio Media Streams always uses µ-law 8kHz mono. */
export const TWILIO_SAMPLE_RATE = 8000;
/** Twilio Media Streams delivers audio in 20ms frames. */
export const TWILIO_FRAME_MS = 20;
/** 20ms of µ-law 8kHz mono = 160 bytes. */
export const TWILIO_FRAME_BYTES = (TWILIO_SAMPLE_RATE * TWILIO_FRAME_MS) / 1000;

const E164_RE = /^\+[1-9]\d{6,14}$/;
// DTMF tones: digits 0–9, star, pound, wait-1sec (w, W). No other chars.
// Guards against TwiML XML injection in sendDtmfOnCall.
const DTMF_RE = /^[0-9*#wW]+$/;

/** Throw unless `phoneNumber` is a valid E.164 string (`+` then 7–15 digits). */
export function validateE164(phoneNumber: string): void {
  if (!E164_RE.test(phoneNumber)) {
    throw new Error(
      `phone_number ${JSON.stringify(phoneNumber)} is not in E.164 format ` +
        `(expected e.g. '+14155551234', pattern: leading '+' then 7–15 digits).`,
    );
  }
}

/** Throw unless `tones` is a valid DTMF string (`[0-9*#wW]+`). */
export function validateDtmf(tones: string): void {
  if (!tones || !DTMF_RE.test(tones)) {
    throw new Error(
      `DTMF tones ${JSON.stringify(tones)} must match [0-9*#wW]+ — ` +
        `this string is embedded in TwiML, non-DTMF chars are rejected ` +
        `to prevent XML injection.`,
    );
  }
}

// ---------------------------------------------------------------- g711 µ-law codec

/**
 * G.711 µ-law encode bias. The G.711 spec adds 0x84 to the magnitude before
 * segment encoding so a zero PCM input maps to a non-zero µ-law byte (per the
 * standard's silent-suppression behavior).
 */
const MULAW_BIAS = 0x84;
/** µ-law clip threshold — magnitudes above this saturate to the top segment. */
const MULAW_CLIP = 32635;

/**
 * Encode one PCM16 sample (-32768..32767) to one µ-law byte (G.711).
 *
 * Direct port of the ITU-T G.711 reference encode formula. Sign is captured in
 * the high bit of the output byte; magnitude is segmented into 8 logarithmic
 * regions of 16 codes each. Output is XORed with 0xff so silent input encodes
 * to 0xff (per the spec's "complemented" form used by every real-world µ-law
 * system, including Twilio). Identical math to Python's `audioop.lin2ulaw`.
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
  return ~(sign | (segment << 4) | quant) & 0xff;
}

/**
 * Decode one µ-law byte (G.711) to one PCM16 sample.
 *
 * Direct port of the ITU-T G.711 reference decode formula. Reverses the encode:
 * complement the byte, split off sign/segment/quant, expand to 14-bit magnitude
 * (rebiased), shift up to 16-bit PCM, apply sign.
 */
function mulawDecodeSample(byte: number): number {
  const inverted = ~byte & 0xff;
  const sign = inverted & 0x80;
  const segment = (inverted >> 4) & 0x07;
  const quant = inverted & 0x0f;
  // Expand: position the quant bits in the segment-dependent magnitude window,
  // set the segment's implicit "1" bit, rebias, and rescale.
  let magnitude = ((quant << 3) | 0x84) << segment;
  magnitude -= MULAW_BIAS;
  return sign ? -magnitude : magnitude;
}

/**
 * Decode a µ-law 8kHz byte stream to PCM16 8kHz little-endian bytes.
 * Internal — exported for testing. Sample-rate conversion is a separate step
 * ({@link resamplePcm16}).
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
 * Internal — exported for testing. Sample-rate conversion is a separate step
 * ({@link resamplePcm16}).
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
 * stateless linear interpolation between adjacent input samples. Good enough
 * for the round-trip fidelity Twilio Media Streams already tolerates (8 kHz
 * µ-law loses high-band content; resampling math doesn't move the needle on
 * quality).
 *
 * Returns the input buffer unchanged when `fromRate === toRate` (identity), so
 * a same-rate call is a no-op.
 *
 * Exposed for tests; production callers should use the named `*At24k` helpers
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
  // Use Math.round for output length so 8k→24k of N samples gives ~3N out, and
  // 24k→8k of 3N gives ~N out (matches what callers expect downstream).
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
 * Alias of {@link mulaw8kToPcm16At24k}. Kept so the Twilio trio
 * (twilio.ts / twilio-server.ts) can keep its existing `*_24k` call sites.
 */
export const mulaw8kToPcm16_24k = mulaw8kToPcm16At24k;

/**
 * Alias of {@link pcm16At24kToMulaw8k}. Kept so the Twilio trio can keep its
 * existing `*_24k` call sites.
 */
export const pcm16_24kToMulaw8k = pcm16At24kToMulaw8k;

/**
 * Split a µ-law buffer into 20ms (160-byte) frames for Media Streams. The final
 * frame may be short if the input isn't a multiple of 160; the adapter drops
 * short frames upstream (see {@link PipecatAgentAdapter}).
 */
export function* iterMulawFrames(mulaw: Uint8Array): Generator<Uint8Array> {
  for (let i = 0; i < mulaw.length; i += TWILIO_FRAME_BYTES) {
    yield mulaw.subarray(i, Math.min(i + TWILIO_FRAME_BYTES, mulaw.length));
  }
}

// ---------------------------------------------------------------- frame protocol

export type MediaStreamEventName =
  | "connected"
  | "start"
  | "media"
  | "stop"
  | "dtmf"
  | "mark";

/** Parsed Twilio Media Streams event. */
export interface MediaStreamEvent {
  event: MediaStreamEventName;
  streamSid?: string;
  callSid?: string;
  /** Decoded µ-law payload (present for `media` frames). */
  payloadMulaw?: Uint8Array;
  /** DTMF digit (present for `dtmf` frames). */
  dtmfDigit?: string;
  /** Mark name (present for `mark` frames). */
  markName?: string;
}

const KNOWN_EVENTS = new Set<MediaStreamEventName>([
  "connected",
  "start",
  "media",
  "stop",
  "dtmf",
  "mark",
]);

/**
 * Parse a JSON frame received from Twilio Media Streams.
 *
 * Returns `null` for unknown event types, malformed JSON, or events with
 * missing required fields. Callers should treat `null` as "ignore this frame"
 * — Twilio occasionally adds new event types and we don't want unknown-event
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
  if (!KNOWN_EVENTS.has(event as MediaStreamEventName)) return null;

  const start = (data.start ?? {}) as Record<string, unknown>;
  const streamSid =
    (typeof data.streamSid === "string" && data.streamSid) ||
    (typeof start.streamSid === "string" && start.streamSid) ||
    undefined;
  const callSid = typeof start.callSid === "string" ? start.callSid : undefined;

  if (event === "media") {
    const media = (data.media ?? {}) as Record<string, unknown>;
    const b64 = media.payload;
    if (typeof b64 !== "string") return null;
    let payload: Buffer;
    try {
      payload = Buffer.from(b64, "base64");
    } catch {
      return null;
    }
    return {
      event: "media",
      streamSid,
      callSid,
      payloadMulaw: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    };
  }

  if (event === "dtmf") {
    const dtmf = (data.dtmf ?? {}) as Record<string, unknown>;
    const digit = dtmf.digit;
    if (typeof digit !== "string") return null;
    return { event: "dtmf", streamSid, dtmfDigit: digit };
  }

  if (event === "mark") {
    const mark = (data.mark ?? {}) as Record<string, unknown>;
    const name = typeof mark.name === "string" ? mark.name : undefined;
    return { event: "mark", streamSid, markName: name };
  }

  // connected, start, stop — no payload-specific fields.
  return { event: event as MediaStreamEventName, streamSid, callSid };
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
 * Build an outbound `clear` frame — tells the receiver to drop buffered audio.
 * Used for interruption: when the user starts talking while the agent is
 * mid-utterance, `clear` stops in-flight TTS playback.
 */
export function buildClearFrame(streamSid: string): string {
  return JSON.stringify({ event: "clear", streamSid });
}

/**
 * Build an outbound `mark` frame — a named marker in the audio stream.
 * Cooperating receivers echo the mark back once the audio that preceded it has
 * been played out. Used as an explicit end-of-turn signal so SUTs don't have to
 * guess via VAD timing.
 */
export function buildMarkFrame(streamSid: string, name: string): string {
  return JSON.stringify({ event: "mark", streamSid, mark: { name } });
}

// ---------------------------------------------------------------- REST helpers

/**
 * Minimal Twilio REST client: just the operations the adapter needs. Uses
 * `fetch` directly so we don't take on the `twilio` npm SDK as a dependency.
 *
 * Errors from the REST API are surfaced as plain `Error` with the HTTP status
 * and response body included; callers wrap the message rather than introspect.
 */
export class TwilioRESTHelper {
  readonly accountSid: string;
  readonly authToken: string;
  readonly fetchImpl: typeof fetch;

  constructor(accountSid: string, authToken: string, fetchImpl: typeof fetch = fetch) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.fetchImpl = fetchImpl;
  }

  private get _authHeader(): string {
    const token = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    return `Basic ${token}`;
  }

  private get _baseUrl(): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;
  }

  private async _request(
    method: "GET" | "POST",
    path: string,
    body?: URLSearchParams,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: this._authHeader,
      Accept: "application/json",
    };
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const response = await this.fetchImpl(`${this._baseUrl}${path}`, {
      method,
      headers,
      body: body ? body.toString() : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Twilio REST ${method} ${path} failed: ${response.status} ${text}`);
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }

  /** Look up the `PN…` SID for a Twilio-owned phone number. */
  async resolvePhoneNumberSid(phoneNumber: string): Promise<string> {
    const params = new URLSearchParams({ PhoneNumber: phoneNumber, PageSize: "1" });
    const data = (await this._request("GET", `/IncomingPhoneNumbers.json?${params}`)) as {
      incoming_phone_numbers?: Array<{ sid?: string }>;
    };
    const sid = data.incoming_phone_numbers?.[0]?.sid;
    if (!sid) {
      throw new Error(
        `No incoming phone number found on this Twilio account matching ` +
          `${JSON.stringify(phoneNumber)}. Check that the number is purchased and in E.164.`,
      );
    }
    return sid;
  }

  /** Fetch the current `voice_url` configured on the number. */
  async readVoiceUrl(phoneNumberSid: string): Promise<string | null> {
    const data = (await this._request(
      "GET",
      `/IncomingPhoneNumbers/${phoneNumberSid}.json`,
    )) as { voice_url?: string };
    return data.voice_url || null;
  }

  async writeVoiceUrl(phoneNumberSid: string, voiceUrl: string): Promise<void> {
    const body = new URLSearchParams({ VoiceUrl: voiceUrl });
    await this._request("POST", `/IncomingPhoneNumbers/${phoneNumberSid}.json`, body);
  }

  /**
   * Originate an outbound call. Returns the call SID.
   *
   * `twiml` is inline TwiML run when the call connects. We do not accept a
   * `twimlUrl` — the historical Python version dropped that too (SSRF-via-
   * Twilio risk if a caller ever passed an attacker-controlled URL).
   */
  async placeCall(args: { to: string; from: string; twiml: string }): Promise<string> {
    const body = new URLSearchParams({
      To: args.to,
      From: args.from,
      Twiml: args.twiml,
    });
    const data = (await this._request("POST", `/Calls.json`, body)) as { sid?: string };
    if (!data.sid) {
      throw new Error("Twilio REST Calls.create returned no sid");
    }
    return data.sid;
  }

  /** Send DTMF on an in-progress call via TwiML update with `<Play digits>`. */
  async sendDtmfOnCall(callSid: string, tones: string): Promise<void> {
    validateDtmf(tones);
    const twiml = `<Response><Play digits="${tones}"/></Response>`;
    const body = new URLSearchParams({ Twiml: twiml });
    await this._request("POST", `/Calls/${callSid}.json`, body);
  }
}

// ---------------------------------------------------------------- utilities

/**
 * Redact an E.164 phone number for logs: `+14155551234` → `***1234`.
 *
 * Last-4 digits only; inputs with fewer than 4 digits collapse to `***`. Avoids
 * leaking full PSTN numbers into CI logs (GitHub retains workflow artifacts for
 * 14 days).
 */
export function redactE164(number: string | undefined | null): string {
  if (!number) return "***";
  const digits = number.replace(/\D/g, "");
  if (digits.length >= 4) return `***${digits.slice(-4)}`;
  return "***";
}

/**
 * Escape a string for safe interpolation into XML attribute values / element
 * text. Used by the TwiML response builder so the stream URL never breaks out
 * of the `url="..."` attribute.
 */
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Verify an `X-Twilio-Signature` header. Twilio signs the request as
 * HMAC-SHA1(authToken, url + sortedParamsConcat) and sends the base64-encoded
 * result. We reconstruct the same input and compare.
 *
 * Returns false on any error (missing header, missing crypto, bad shape) — fail
 * closed.
 */
export async function verifyTwilioSignature(args: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | null | undefined;
}): Promise<boolean> {
  if (!args.signature) return false;
  try {
    const sortedKeys = Object.keys(args.params).sort();
    let data = args.url;
    for (const key of sortedKeys) data += key + args.params[key];
    const { createHmac, timingSafeEqual } = await import("node:crypto");
    const expected = createHmac("sha1", args.authToken).update(data).digest();
    const received = Buffer.from(args.signature, "base64");
    // `timingSafeEqual` requires equal-length inputs. Mismatched lengths are by
    // definition unequal — return false without measuring further.
    if (expected.length !== received.length) return false;
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}
