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
 * ones. The expected sample values come from an independent G.711 µ-law decoder
 * implemented in this file, and are compared POSITIONALLY against a waveform
 * that visits all 256 µ-law code points. That combination is what makes the
 * reference decoder able to disagree: a set-membership assertion over a constant
 * tone is invariant under any permutation, duplication or drop of the samples —
 * reversing the shipped decoder's output passed it — and it exercises 1 of 256
 * codes, leaving the negative half of the table, the segment shift and the bias
 * term unchecked.
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
/** µ-law bytes in one 100ms batch. */
const BATCH_MULAW_BYTES = FRAMES_PER_BATCH * TWILIO_FRAME_BYTES; // 800
/** Both rates are fixed by the transports, so the 8k→24k factor is a constant. */
const UPSAMPLE_FACTOR = 3;

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
  const sample = inverted & 0x80 ? -magnitude : magnitude;
  // JS has a signed zero; PCM16 does not. Normalise, or the negative half of
  // the table's zero code decodes to `-0` and compares unequal to the shipped
  // decoder's `0`.
  return sample === 0 ? 0 : sample;
}

/**
 * One batch of µ-law that visits every code point, so no assertion below can be
 * satisfied by a codec that only handles the positive half of the table, or by
 * one that reorders, drops or duplicates samples.
 */
const RAMP_MULAW = Uint8Array.from({ length: BATCH_MULAW_BYTES }, (_, i) => i % 256);
/** What the reference decoder says each of those bytes is worth. */
const RAMP_PCM16_8K = Array.from(RAMP_MULAW, mulawDecode);

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

    const frames: string[] = [];
    for (let i = 0; i < BATCH_MULAW_BYTES; i += TWILIO_FRAME_BYTES) {
      frames.push(mediaFrame(RAMP_MULAW.slice(i, i + TWILIO_FRAME_BYTES)));
    }
    const ws = scriptedSocket([startFrame({ nonce }), ...frames]);
    // `drive` returns once the socket parks; the loop itself keeps running, which
    // is what keeps the stream live for the outbound half below.
    await drive(adapter, ws);
    await call;

    // ------------------------------------------------------------- inbound
    const chunk = await adapter.receiveAudio(1);
    const decoded = samples(chunk.data);

    // 8k → 24k with linear interpolation puts input sample i exactly on output
    // index 3i, so the reference decoder can be checked sample by sample — the
    // whole point of driving a VARYING waveform.
    expect(
      RAMP_PCM16_8K.slice(0, -1).map((_, i) => decoded[UPSAMPLE_FACTOR * i]),
      "inbound µ-law reached the queue mis-decoded, reordered or resampled wrong",
    ).toEqual(RAMP_PCM16_8K.slice(0, -1));
    // ± the resampler's end-of-buffer rounding.
    expect(
      Math.abs(decoded.length - UPSAMPLE_FACTOR * BATCH_MULAW_BYTES),
    ).toBeLessThanOrEqual(2);
    expect(adapter._framesReceivedForTest).toBe(FRAMES_PER_BATCH);

    // ------------------------------------------------------------ outbound
    // Hold each 8kHz level for 3 samples at 24kHz so the downsample is the exact
    // inverse of the upsample above; every value is already a µ-law
    // quantisation level, so the encode round-trips exactly and a positional
    // assertion needs no tolerance.
    const outboundSamples = RAMP_PCM16_8K.length * UPSAMPLE_FACTOR;
    const pcm = new Uint8Array(outboundSamples * 2);
    const pcmView = new DataView(pcm.buffer);
    for (let i = 0; i < outboundSamples; i++) {
      pcmView.setInt16(i * 2, RAMP_PCM16_8K[Math.floor(i / UPSAMPLE_FACTOR)], true);
    }
    await adapter.sendAudio(new AudioChunk({ data: pcm }));

    const sent = ws.sent.map((text) => JSON.parse(text));
    expect(sent.map((f) => f.event)).toEqual(Array(FRAMES_PER_BATCH).fill("media"));
    expect(new Set(sent.map((f) => f.streamSid))).toEqual(new Set(["MZ762"]));

    const payloads = sent.map((f) =>
      new Uint8Array(Buffer.from(f.media.payload as string, "base64")),
    );
    expect(payloads.map((p) => p.length)).toEqual(
      Array(FRAMES_PER_BATCH).fill(TWILIO_FRAME_BYTES),
    );
    const emitted = payloads.flatMap((p) => Array.from(p, mulawDecode));
    expect(
      emitted,
      "outbound PCM16 left the socket mis-encoded, reordered or resampled wrong",
    ).toEqual(RAMP_PCM16_8K);
  });
});
