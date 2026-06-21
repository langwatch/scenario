/**
 * Issue #695 — the Twilio adapter must terminate its inbound queue on a silent
 * / tool-only completion (a #648-class dead-recv-loop hang).
 *
 * The Media Streams loop (`TwilioWebhookServer.mediaStreamLoop`) is the
 * *producer* for the adapter's inbound queue; `receiveAudio` is a bare
 * `queue.take()`. A turn that completed WITHOUT trailing audio — a `"stop"`
 * frame with nothing buffered (a silent agent turn or a tool-only turn), or a
 * socket close — left the queue empty, so `receiveAudio` rejected at
 * `responseTimeout` instead of returning cleanly. This is the same latent hang
 * fixed for ElevenLabs / generic WebSocket in #648 and for OpenAI Realtime in
 * #646.
 *
 * The fix mirrors that reference pattern: on *any* terminal exit of the loop,
 * enqueue an empty `AudioChunk` so the base `drainAgentResponse` (which breaks
 * on an empty chunk) exits cleanly.
 *
 * These tests drive the loop via the `_driveMediaStream` seam with a scripted
 * mock socket — the adapter binds an OS-assigned port via `connect()` (stubbed
 * REST, no real Twilio account) but no real WS upgrade happens. `receiveAudio`
 * is handed a short budget so an un-fixed adapter (empty queue) rejects fast
 * instead of stalling the suite; the fix resolves immediately from the
 * already-enqueued sentinel, so that budget never actually elapses on green.
 */

import { afterEach, describe, expect, it } from "vitest";

import { AudioChunk } from "../../audio-chunk";
import { TwilioAgentAdapter } from "../twilio";
import type { MediaStreamWebSocket } from "../twilio-server";
import { buildMediaFrame, TwilioRESTHelper } from "../twilio-shared";

const STREAM_SID = "MZ695";
// receiveAudio budget: an un-fixed adapter leaves the queue empty and `take`
// rejects after this many seconds (the red signal). The fix resolves instantly
// from the already-enqueued sentinel, so this never elapses on green.
const RECV_TIMEOUT_S = 2;

function startFrame(streamSid = STREAM_SID, callSid = "CA695"): string {
  return JSON.stringify({ event: "start", start: { streamSid, callSid } });
}

function stopFrame(): string {
  return JSON.stringify({ event: "stop" });
}

/**
 * A `MediaStreamWebSocket` double whose `receiveText()` serves `frames` in
 * order, then resolves `null` (a socket close — the real adapter's close
 * signal). Every test scripts an explicit terminal: a `"stop"` frame the loop
 * returns on, or the trailing close.
 */
function scriptedSocket(frames: string[]): MediaStreamWebSocket {
  let idx = 0;
  return {
    send() {
      // Outbound is irrelevant to these inbound-drain tests.
    },
    receiveText() {
      if (idx < frames.length) return Promise.resolve(frames[idx++]!);
      return Promise.resolve(null); // socket closed
    },
    close() {
      // No-op for the double.
    },
  };
}

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

async function connectedAdapter(): Promise<TwilioAgentAdapter> {
  const adapter = new TwilioAgentAdapter({
    accountSid: "ACtest",
    authToken: "secret",
    phoneNumber: "+14155556959",
    publicBaseUrl: "https://example695.test",
    rest: stubRest(),
  });
  await adapter.connect();
  tracked.push(adapter);
  return adapter;
}

afterEach(async () => {
  while (tracked.length > 0) {
    try {
      await tracked.pop()!.disconnect();
    } catch {
      // Best-effort teardown.
    }
  }
});

describe("Twilio silent / tool-only stop (#695 dead-recv-loop)", () => {
  it("stop frame with no trailing audio returns an empty chunk, not a hang", async () => {
    const adapter = await connectedAdapter();
    // start → stop, no media: the "stop" branch flushes nothing.
    await adapter._driveMediaStream(scriptedSocket([startFrame(), stopFrame()]));

    const chunk = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(chunk).toBeInstanceOf(AudioChunk);
    expect(chunk.data.length).toBe(0); // empty terminal, not a hang
  });

  it("socket close mid-stream returns an empty chunk, not a hang", async () => {
    const adapter = await connectedAdapter();
    // Only a start frame, then the socket closes (receiveText → null).
    await adapter._driveMediaStream(scriptedSocket([startFrame()]));

    const chunk = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(chunk.data.length).toBe(0);
  });

  it("normal audio turn still drains its trailing PCM (no regression)", async () => {
    const adapter = await connectedAdapter();
    // 160 bytes of µ-law (~20ms) — under the 100ms batch threshold, so the
    // "stop" flush is what enqueues it: exactly the trailing-audio path.
    const mulaw = new Uint8Array(160).fill(0x7f);
    await adapter._driveMediaStream(
      scriptedSocket([startFrame(), buildMediaFrame(STREAM_SID, mulaw), stopFrame()]),
    );

    const first = await adapter.receiveAudio(RECV_TIMEOUT_S);
    // Real audio survived as the first chunk; the sentinel lands after it.
    expect(first.data.length).toBeGreaterThan(0);
  });
});
