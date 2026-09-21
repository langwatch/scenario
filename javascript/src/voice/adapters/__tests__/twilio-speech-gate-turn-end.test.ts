/**
 * Turn-taking on a continuously streaming phone line (langwatch/langwatch#8014
 * follow-up): the drain's tail-silence turn end must fire while Twilio is still
 * delivering silent media frames.
 *
 * On a real a-leg call the far end never stops sending: Twilio Media Streams
 * emit a `media` frame every 20 ms for the life of the call, comfort noise and
 * line noise included. `drainAgentResponse` ends a turn on an ARRIVAL GAP of
 * `responseTailSilence` seconds, so pre-fix the callee's turn could only end on
 * hangup (terminal sentinel) or the hard ceiling — the callee was heard asking
 * "hello? are you still there?" for 40 s while the simulated caller waited for
 * a turn it never got. Both real calls' `voice.audio.receive` spans said
 * `terminated_reason = terminal_chunk | hard_ceiling`, never `tail_silence`.
 *
 * These tests drive the REAL `/twilio/stream` route with a real `ws` client and
 * the REAL production consumer (`driveCall` → `adapter.call()` → the drain),
 * exactly like the #695 anti-drift suite, and keep silent frames flowing at
 * wall-clock pace through the whole turn. With the gate on, the turn ends
 * while noise is still streaming; with `speechGate: false` (pre-fix
 * behaviour) it provably cannot.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { driveCall } from "../../__tests__/helpers/drive-production";
import { extractAudio } from "../../messages";
import { TwilioAgentAdapter, type TwilioAgentAdapterOptions } from "../twilio";
import { TWILIO_SAMPLE_RATE, buildMediaFrame, pcm16ToMulaw, TwilioRESTHelper } from "../twilio-shared";

const STREAM_SID = "MZ8014";
// One media-loop flush: 800 µ-law bytes == 100 ms == the loop's flush threshold,
// so every frame we send lands in the inbound queue immediately.
const FRAME_MS = 100;
const FRAME_BYTES = (TWILIO_SAMPLE_RATE * FRAME_MS) / 1000;
// Drain budget for the "gate off" proof: long enough to show the turn does NOT
// end on its own while noise streams, short enough to keep the test fast.
const TAIL_SILENCE_S = 0.5;

/** 100 ms of µ-law sine at the given int16 RMS (amplitude = rms · √2). */
function mulawTone(rms: number): Uint8Array {
  const samples = FRAME_BYTES;
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  const amplitude = rms * Math.SQRT2;
  for (let i = 0; i < samples; i++) {
    // 440 Hz so µ-law quantisation and the 8k→24k resample leave the RMS intact.
    const s = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / TWILIO_SAMPLE_RATE));
    view.setInt16(i * 2, s, true);
  }
  return pcm16ToMulaw(pcm);
}

// Well either side of the default 800 threshold (measured noise p95 ≈ 740,
// speech p50 ≈ 1380): a quiet line and a callee talking.
const NOISE_FRAME = mulawTone(600);
const SPEECH_FRAME = mulawTone(1700);

function stubRest(): TwilioRESTHelper {
  const stub = new TwilioRESTHelper("ACtest", "secret");
  stub.resolvePhoneNumberSid = async () => "PNxxxx";
  stub.readVoiceUrl = async () => null;
  stub.writeVoiceUrl = async () => undefined;
  stub.placeCall = async () => "CAtest";
  stub.sendDtmfOnCall = async () => undefined;
  return stub;
}

const tracked: TwilioAgentAdapter[] = [];
const timers: Array<ReturnType<typeof setInterval>> = [];

async function routeAdapter(
  extra: Partial<TwilioAgentAdapterOptions> = {},
): Promise<TwilioAgentAdapter> {
  const adapter = new TwilioAgentAdapter({
    accountSid: "ACtest",
    authToken: "secret",
    phoneNumber: "+14155558014",
    publicBaseUrl: "https://example8014.test",
    rest: stubRest(),
    ...extra,
  });
  await adapter.connect(); // starts the REAL http+ws server
  adapter.responseTimeout = 5;
  adapter.responseTailSilence = TAIL_SILENCE_S;
  tracked.push(adapter);
  return adapter;
}

function openClient(adapter: TwilioAgentAdapter): Promise<WebSocket> {
  const url = `${adapter.localBaseUrl.replace(/^http:/, "ws:")}/twilio/stream`;
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

async function startCall(adapter: TwilioAgentAdapter): Promise<WebSocket> {
  const client = await openClient(adapter);
  client.send(JSON.stringify({ event: "start", start: { streamSid: STREAM_SID, callSid: "CA8014" } }));
  await vi.waitFor(() => expect(adapter._streamSidForTest).toBe(STREAM_SID), { timeout: 5_000 });
  return client;
}

/** Keep `frame` flowing at wall-clock pace, like Twilio does, until stopped. */
function stream(client: WebSocket, frame: Uint8Array): () => void {
  const timer = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) client.send(buildMediaFrame(STREAM_SID, frame));
  }, FRAME_MS);
  timers.push(timer);
  return () => clearInterval(timer);
}

const audioBytes = (message: unknown): number => extractAudio(message)?.data.length ?? 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  while (timers.length > 0) clearInterval(timers.pop()!);
  while (tracked.length > 0) {
    try {
      await tracked.pop()!.disconnect();
    } catch {
      // Best-effort teardown.
    }
  }
});

describe("Twilio turn end on a continuously streaming line (speech gate)", () => {
  it("ends the callee's turn on tail silence while silent frames keep arriving", async () => {
    const adapter = await routeAdapter();
    const client = await startCall(adapter);

    // Line noise streams from the start; the callee has not spoken yet.
    const stopNoise = stream(client, NOISE_FRAME);
    const call = driveCall(adapter);
    await sleep(600); // > tail silence: with the gate off this alone would not end the turn (nothing admitted yet either way)

    // The callee talks for ~1 s (10 flushes), then goes quiet — but Twilio
    // keeps streaming the quiet line the whole time.
    for (let i = 0; i < 10; i++) {
      client.send(buildMediaFrame(STREAM_SID, SPEECH_FRAME));
      await sleep(FRAME_MS);
    }
    const spokeUntil = Date.now();

    const message = await call;
    const endedAfterMs = Date.now() - spokeUntil;
    stopNoise();

    // The turn ended on its own, carrying the speech, while noise was still
    // flowing: hangover (400 ms) + tail silence (500 ms) plus scheduling slack,
    // and nowhere near the drain's hard ceiling.
    expect(audioBytes(message)).toBeGreaterThan(0);
    expect(endedAfterMs).toBeLessThan(2_500);
    const gate = adapter._speechGateForTest!;
    expect(gate.onsets).toBe(1);
    expect(gate.droppedChunks).toBeGreaterThan(0);
    client.close();
  }, 15_000);

  it("the same line with speechGate: false never reaches tail silence (pre-fix behaviour)", async () => {
    const adapter = await routeAdapter({ speechGate: false });
    expect(adapter._speechGateForTest).toBeNull();
    const client = await startCall(adapter);

    const stopNoise = stream(client, NOISE_FRAME);
    const call = driveCall(adapter);
    await sleep(300);
    for (let i = 0; i < 10; i++) {
      client.send(buildMediaFrame(STREAM_SID, SPEECH_FRAME));
      await sleep(FRAME_MS);
    }

    // Long past hangover + tail silence: the turn is still open because every
    // noise frame resets the drain's arrival gap.
    let settled = false;
    void call.then(() => {
      settled = true;
    });
    await sleep(2_000);
    expect(settled).toBe(false);

    // Only once the line goes quiet for real (frames STOP arriving) does the
    // ungated drain see its gap and close the turn.
    stopNoise();
    const message = await call;
    expect(audioBytes(message)).toBeGreaterThan(0);
    client.close();
  }, 15_000);

  it("a second turn on the same call gets its own onset after the caller's silence", async () => {
    const adapter = await routeAdapter();
    const client = await startCall(adapter);
    const stopNoise = stream(client, NOISE_FRAME);

    for (let turn = 1; turn <= 2; turn++) {
      const call = driveCall(adapter);
      await sleep(300);
      for (let i = 0; i < 5; i++) {
        client.send(buildMediaFrame(STREAM_SID, SPEECH_FRAME));
        await sleep(FRAME_MS);
      }
      const message = await call;
      expect(audioBytes(message)).toBeGreaterThan(0);
      expect(adapter._speechGateForTest!.onsets).toBe(turn);
    }
    stopNoise();
    client.close();
  }, 15_000);
});
