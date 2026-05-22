/**
 * Shared primitives for the Twilio adapter: µ-law/PCM16 codec, Media Streams
 * JSON wire-format helpers, E.164 / DTMF validation, and a small REST client.
 *
 * TS port of `python/scenario/voice/adapters/_twilio_shared.py`. The Python
 * version leans on stdlib `audioop` for µ-law conversion and 8 kHz ↔ 24 kHz
 * resampling; we re-implement those inline because Node has no audioop
 * equivalent. The algorithms are the same — see comments by each function.
 *
 * Not exported from `voice/index.ts`. Internal to the adapter module.
 *
 * NOTE: this file conceptually belongs to PR10 (Pipecat g711). PR10 has not
 * landed at the time this PR was opened, so PR11 ships the shared module to
 * unblock itself. When PR10 lands, the two files can be reconciled — they
 * share the same name and same surface area by design.
 */

import { Buffer } from "node:buffer";

import { PCM16_SAMPLE_RATE, PCM16_SAMPLE_WIDTH_BYTES } from "../audio-chunk";

// Twilio Media Streams always uses µ-law 8 kHz mono.
export const TWILIO_SAMPLE_RATE = 8000;
// 20 ms frames at 8 kHz µ-law → 160 bytes per frame.
export const TWILIO_FRAME_MS = 20;
export const TWILIO_FRAME_BYTES =
  (TWILIO_SAMPLE_RATE * TWILIO_FRAME_MS) / 1000;

const E164_RE = /^\+[1-9]\d{6,14}$/;
// DTMF tones: digits 0–9, star, pound, wait-1sec (w, W). No other chars.
// Guards against TwiML XML injection in sendDtmfOnCall.
const DTMF_RE = /^[0-9*#wW]+$/;

export function validateE164(phoneNumber: string): void {
  if (!E164_RE.test(phoneNumber)) {
    throw new Error(
      `phone_number ${JSON.stringify(phoneNumber)} is not in E.164 format ` +
        `(expected e.g. '+14155551234', pattern: leading '+' then 7–15 digits).`,
    );
  }
}

export function validateDtmf(tones: string): void {
  if (!tones || !DTMF_RE.test(tones)) {
    throw new Error(
      `DTMF tones ${JSON.stringify(tones)} must match [0-9*#wW]+ — ` +
        `this string is embedded in TwiML, non-DTMF chars are rejected ` +
        `to prevent XML injection.`,
    );
  }
}

// ---------------------------------------------------------------- codec

const BIAS = 0x84;
const CLIP = 32635;

/**
 * Encode a single PCM16 sample (little-endian, signed) to a µ-law byte.
 * Reference algorithm: ITU-T G.711 µ-law. Identical math to Python's
 * `audioop.lin2ulaw` for one sample.
 */
function pcmSampleToMulaw(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulaw;
}

/** Decode a single µ-law byte → PCM16 signed sample. */
function mulawByteToPcmSample(ulaw: number): number {
  ulaw = ~ulaw & 0xff;
  const sign = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

/**
 * Linear resample of mono PCM16. Used to bridge 8 kHz (Twilio) and 24 kHz
 * (our canonical internal rate). Simple linear interpolation; good enough for
 * speech and matches what `audioop.ratecv` produces in spirit.
 */
function resamplePcm16(
  pcm: Uint8Array,
  fromRate: number,
  toRate: number,
): Uint8Array {
  if (pcm.length === 0 || fromRate === toRate) return pcm;
  const inputSamples = pcm.length / PCM16_SAMPLE_WIDTH_BYTES;
  const outputSamples = Math.floor((inputSamples * toRate) / fromRate);
  if (outputSamples <= 0) return new Uint8Array(0);
  const inView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Uint8Array(outputSamples * PCM16_SAMPLE_WIDTH_BYTES);
  const outView = new DataView(out.buffer);
  const ratio = (inputSamples - 1) / Math.max(outputSamples - 1, 1);
  for (let i = 0; i < outputSamples; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = inView.getInt16(idx * PCM16_SAMPLE_WIDTH_BYTES, true);
    const next = Math.min(idx + 1, inputSamples - 1);
    const s1 = inView.getInt16(next * PCM16_SAMPLE_WIDTH_BYTES, true);
    const interp = Math.round(s0 + (s1 - s0) * frac);
    outView.setInt16(i * PCM16_SAMPLE_WIDTH_BYTES, interp, true);
  }
  return out;
}

/** Decode µ-law 8 kHz mono → PCM16 24 kHz mono. */
export function mulaw8kToPcm16_24k(mulawBytes: Uint8Array): Uint8Array {
  if (mulawBytes.length === 0) return new Uint8Array(0);
  const pcm8k = new Uint8Array(mulawBytes.length * PCM16_SAMPLE_WIDTH_BYTES);
  const view = new DataView(pcm8k.buffer);
  for (let i = 0; i < mulawBytes.length; i++) {
    view.setInt16(i * PCM16_SAMPLE_WIDTH_BYTES, mulawByteToPcmSample(mulawBytes[i]!), true);
  }
  return resamplePcm16(pcm8k, TWILIO_SAMPLE_RATE, PCM16_SAMPLE_RATE);
}

/** Encode PCM16 24 kHz mono → µ-law 8 kHz mono. */
export function pcm16_24kToMulaw8k(pcm16Bytes: Uint8Array): Uint8Array {
  if (pcm16Bytes.length === 0) return new Uint8Array(0);
  const pcm8k = resamplePcm16(pcm16Bytes, PCM16_SAMPLE_RATE, TWILIO_SAMPLE_RATE);
  const sampleCount = pcm8k.length / PCM16_SAMPLE_WIDTH_BYTES;
  const view = new DataView(pcm8k.buffer, pcm8k.byteOffset, pcm8k.byteLength);
  const out = new Uint8Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = pcmSampleToMulaw(view.getInt16(i * PCM16_SAMPLE_WIDTH_BYTES, true));
  }
  return out;
}

/** Split a µ-law buffer into 20 ms (160-byte) frames for Media Streams. */
export function* iterMulawFrames(mulawBytes: Uint8Array): Generator<Uint8Array> {
  for (let i = 0; i < mulawBytes.length; i += TWILIO_FRAME_BYTES) {
    yield mulawBytes.subarray(i, Math.min(i + TWILIO_FRAME_BYTES, mulawBytes.length));
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
 * missing required fields. Callers should treat `null` as "ignore this frame".
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
 * Build an outbound `clear` frame — tells Twilio to drop buffered audio.
 *
 * Used for interruption handling: if the agent was speaking and the user
 * interrupts, we send `clear` so in-flight TTS isn't played.
 */
export function buildClearFrame(streamSid: string): string {
  return JSON.stringify({ event: "clear", streamSid });
}

/** Build an outbound `mark` frame — a named marker in the audio stream. */
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
 * Last-4 digits only; inputs with fewer than 4 digits collapse to `***`.
 * Avoids leaking full PSTN numbers into CI logs (GitHub retains workflow
 * artifacts for 14 days).
 */
export function redactE164(number: string | undefined | null): string {
  if (!number) return "***";
  const digits = number.replace(/\D/g, "");
  if (digits.length >= 4) return `***${digits.slice(-4)}`;
  return "***";
}

/**
 * Escape a string for safe interpolation into XML attribute values / element
 * text. Used by the TwiML response builder so the stream URL never breaks
 * out of the `url="..."` attribute.
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
 * HMAC-SHA1(authToken, url + sortedParamsConcat) and sends the base64-
 * encoded result. We reconstruct the same input and compare.
 *
 * Returns false on any error (missing header, missing crypto, bad shape)
 * — fail closed.
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
    // `timingSafeEqual` requires equal-length inputs. Mismatched lengths are
    // by definition unequal — return false without measuring further.
    if (expected.length !== received.length) return false;
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}
