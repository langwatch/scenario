/**
 * Ungated a-leg bidirectional frame-loop tripwire (scenario#762 Slice 5, AC14).
 *
 * AC11's live smoke is the only REAL proof that a-leg carries audio, and its env
 * gate never trips in CI — so on its own an a-leg frame-loop regression ships
 * green. This test is the standing substitute: it drives the production media
 * loop over the scripted in-memory socket the nonce tests already use, and
 * asserts on the BYTES that come out of the real codec in both directions.
 *
 * Nothing here is mocked below the socket: the µ-law decode, the 8k→24k
 * resample, the 20ms framing and the base64 wire encoding are all the shipped
 * ones. The expected sample values are computed by an independent G.711 µ-law
 * decoder implemented in this file, so a broken codec cannot agree with the
 * assertion by construction.
 *
 * Binds AC14 of `specs/voice-twilio-a-leg-external.feature`. Mirrors
 * `python/tests/voice/test_twilio_frame_loop.py`.
 */

import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it } from "vitest";

import { AudioChunk } from "../../audio-chunk";
import { TwilioAgentAdapter } from "../twilio";
import { TWILIO_FRAME_BYTES } from "../twilio-shared";
import {
  drive,
  makeAdapter,
  scriptedSocket,
  spyRest,
  startALegCall,
  startFrame,
} from "./a-leg-harness";

/** One 100ms batch — what the loop coalesces before it enqueues a chunk. */
const FRAMES_PER_BATCH = 5;
/**
 * Arbitrary non-silent µ-law code. Constant across the batch so the resampler's
 * interpolation is the identity on it and every decoded sample is comparable.
 */
const TONE_MULAW_BYTE = 0xd5;
/** Constant PCM16-at-24kHz level for the outbound direction, well inside int16. */
const TONE_PCM16_LEVEL = 1000;

/**
 * Independent G.711 µ-law decode of one byte to a signed 16-bit sample.
 *
 * Deliberately NOT the adapter's decoder: this is the reference the shipped
 * codec is checked against, so it has to be able to disagree with it.
 */
function mulawDecode(byte: number): number {
  const inverted = ~byte & 0xff;
  const magnitude =
    ((((inverted & 0x0f) << 3) | 0x84) << ((inverted >> 4) & 0x07)) - 0x84;
  return inverted & 0x80 ? -magnitude : magnitude;
}

/**
 * An inbound Twilio `media` frame, built here rather than by the adapter.
 *
 * The adapter's own frame builder is the thing under test on the OUTBOUND side;
 * using it to author inbound fixtures too would let one bug cancel out the other.
 */
function mediaFrame(payload: Uint8Array, streamSid = "MZ762"): string {
  return JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: Buffer.from(payload).toString("base64") },
  });
}

function samples(pcm16: Uint8Array): number[] {
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const out: number[] = [];
  for (let i = 0; i < pcm16.length / 2; i++) out.push(view.getInt16(i * 2, true));
  return out;
}

describe("TwilioAgentAdapter a-leg frame loop", () => {
  let openAdapter: TwilioAgentAdapter | null = null;

  afterEach(async () => {
    if (openAdapter) {
      await openAdapter.disconnect();
      openAdapter = null;
    }
  });

  it("AC14: inbound µ-law arrives decoded, and outbound audio leaves as µ-law media frames", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    const { nonce, call } = await startALegCall(adapter, rest);

    const inboundMulaw = new Uint8Array(TWILIO_FRAME_BYTES).fill(TONE_MULAW_BYTE);
    const ws = scriptedSocket([
      startFrame({ nonce }),
      ...Array.from({ length: FRAMES_PER_BATCH }, () => mediaFrame(inboundMulaw)),
    ]);
    // `drive` returns once the socket parks; the loop itself keeps running, which
    // is what keeps the stream live for the outbound half below.
    await drive(adapter, ws);
    await call;

    // ------------------------------------------------------------- inbound
    const chunk = await adapter.receiveAudio(1);
    const decoded = samples(chunk.data);
    const expectedLevel = mulawDecode(TONE_MULAW_BYTE);

    expect(
      new Set(decoded),
      "inbound µ-law must reach the queue decoded to PCM16 by the real codec",
    ).toEqual(new Set([expectedLevel]));
    // 8k → 24k on 5×160 µ-law samples: 3× the samples, ± the resampler's
    // end-of-buffer rounding.
    expect(
      Math.abs(decoded.length - 3 * FRAMES_PER_BATCH * TWILIO_FRAME_BYTES),
    ).toBeLessThanOrEqual(2);
    expect(adapter._framesReceivedForTest).toBe(FRAMES_PER_BATCH);

    // ------------------------------------------------------------ outbound
    const outboundSamples = 2400; // 100ms at 24kHz
    const pcm = new Uint8Array(outboundSamples * 2);
    const pcmView = new DataView(pcm.buffer);
    for (let i = 0; i < outboundSamples; i++) {
      pcmView.setInt16(i * 2, TONE_PCM16_LEVEL, true);
    }
    await adapter.sendAudio(new AudioChunk({ data: pcm }));

    const frames = ws.sent.map((text) => JSON.parse(text));
    expect(frames.map((f) => f.event)).toEqual(Array(FRAMES_PER_BATCH).fill("media"));
    expect(new Set(frames.map((f) => f.streamSid))).toEqual(new Set(["MZ762"]));

    const payloads = frames.map((f) =>
      new Uint8Array(Buffer.from(f.media.payload as string, "base64")),
    );
    expect(payloads.map((p) => p.length)).toEqual(
      Array(FRAMES_PER_BATCH).fill(TWILIO_FRAME_BYTES),
    );
    const levels = new Set(
      payloads.flatMap((p) => Array.from(p, (byte) => mulawDecode(byte))),
    );
    expect(levels.size, "a constant input must encode to a constant code").toBe(1);
    // µ-law is logarithmic: at this level its quantum is ~30, so the round-trip
    // lands near the input rather than on it.
    expect(Math.abs([...levels][0] - TONE_PCM16_LEVEL)).toBeLessThanOrEqual(32);
  });
});
