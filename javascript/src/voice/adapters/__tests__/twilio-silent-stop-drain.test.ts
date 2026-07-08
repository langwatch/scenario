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
 * **Why these tests drive the production wrapper.** In production the loop is
 * reached via `_handleStreamSocket`, whose `finally` nulls `_streamWs` /
 * `_streamSid` synchronously right after the loop returns or throws. A test that
 * drives `mediaStreamLoop` (or the `_driveMediaStream` seam) alone leaves those
 * set, so `receiveAudio`'s `_assertStreamLive` gate never fires — which is why
 * an earlier version of this suite went green on a fix that still threw in
 * production (reviewer P2 blocker on PR #697). These tests use the
 * `_driveStreamSession` seam, which runs the SAME `runStreamSession` wrapper
 * production uses — loop plus the transport-nulling `finally`. The regression
 * the fix targets is the drain's *second* `receiveAudio` call (the tail-silence
 * probe) landing after that reset: pre-fix it throws "no live media stream";
 * post-fix it returns another empty chunk. Each test asserts BOTH calls behave.
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
  it("stop frame with no trailing audio: both drain calls return empty after production teardown", async () => {
    const adapter = await connectedAdapter();
    // start → stop, no media: the "stop" branch flushes nothing. Driven through
    // the REAL production wrapper, which nulls _streamWs/_streamSid on return.
    await adapter._driveStreamSession(scriptedSocket([startFrame(), stopFrame()]));

    // Production nulled the transport — the condition that threw pre-fix.
    expect(adapter._streamWsForTest).toBeNull();
    expect(adapter._streamSidForTest).toBeUndefined();

    const first = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(first).toBeInstanceOf(AudioChunk);
    expect(first.data.length).toBe(0); // empty terminal, not a hang

    // The drain's tail-silence probe — a SECOND receiveAudio after teardown.
    // This is the call that throws "no live media stream" pre-fix.
    const second = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(second.data.length).toBe(0);
  });

  it("socket close mid-stream: both drain calls return empty after production teardown", async () => {
    const adapter = await connectedAdapter();
    // Only a start frame, then the socket closes (receiveText → null).
    await adapter._driveStreamSession(scriptedSocket([startFrame()]));

    expect(adapter._streamWsForTest).toBeNull();
    expect(adapter._streamSidForTest).toBeUndefined();

    const first = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(first.data.length).toBe(0);

    const second = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(second.data.length).toBe(0);
  });

  it("normal audio turn still drains its trailing PCM after production teardown (no regression)", async () => {
    const adapter = await connectedAdapter();
    // 160 bytes of µ-law (~20ms) — under the 100ms batch threshold, so the
    // "stop" flush is what enqueues it: exactly the trailing-audio path.
    const mulaw = new Uint8Array(160).fill(0x7f);
    await adapter._driveStreamSession(
      scriptedSocket([startFrame(), buildMediaFrame(STREAM_SID, mulaw), stopFrame()]),
    );

    expect(adapter._streamWsForTest).toBeNull(); // production teardown ran

    const first = await adapter.receiveAudio(RECV_TIMEOUT_S);
    // Real audio survived as the first chunk; the sentinel lands after it.
    expect(first.data.length).toBeGreaterThan(0);

    // And the terminal sentinel lands AFTER the real audio (FIFO), not instead
    // of it: the next chunk is the empty sentinel. Pins the ordering invariant —
    // a fix that enqueued the sentinel before the flush would fail here. This
    // second call is also the post-teardown drain probe that threw pre-fix.
    const second = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(second.data.length).toBe(0);
  });
});
