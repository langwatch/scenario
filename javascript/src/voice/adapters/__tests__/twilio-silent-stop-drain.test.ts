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

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { defaultVoiceCall } from "../../adapter.runtime";
import { AudioChunk } from "../../audio-chunk";
import { extractAudio } from "../../messages";
import { TwilioAgentAdapter } from "../twilio";
import type { MediaStreamWebSocket } from "../twilio-server";
import { buildMediaFrame, TwilioRESTHelper } from "../twilio-shared";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/**
 * A `MediaStreamWebSocket` double the test can feed mid-flight: `receiveText()`
 * blocks until `push()` supplies a frame — a string frame, `null` (socket
 * close), or an `Error` (transport failure, rejecting the pending read). Used
 * for scenarios that need the loop *live and idle* at the moment the test
 * calls `receiveAudio` (the scripted double above always terminates first).
 */
function controllableSocket(): MediaStreamWebSocket & {
  push(item: string | null | Error): void;
} {
  const queued: Array<string | null | Error> = [];
  const waiters: Array<{
    resolve: (v: string | null) => void;
    reject: (e: Error) => void;
  }> = [];
  return {
    send() {
      // Outbound is irrelevant to these inbound-drain tests.
    },
    close() {
      // No-op for the double.
    },
    push(item: string | null | Error): void {
      const waiter = waiters.shift();
      if (waiter) {
        if (item instanceof Error) waiter.reject(item);
        else waiter.resolve(item);
        return;
      }
      queued.push(item);
    },
    receiveText(): Promise<string | null> {
      if (queued.length > 0) {
        const item = queued.shift()!;
        if (item instanceof Error) return Promise.reject(item);
        return Promise.resolve(item);
      }
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
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

  it("transport error mid-stream: session rejects but both drain calls return empty (throw path)", async () => {
    const adapter = await connectedAdapter();
    // The production `finally` claims all THREE termination paths — stop,
    // close, throw — enqueue the sentinel. This pins the throw path: the
    // socket's pending read rejects, the session surfaces the error, and the
    // drain still terminates cleanly instead of hanging or asserting liveness.
    const sock = controllableSocket();
    const session = adapter._driveStreamSession(sock);
    sock.push(startFrame());
    sock.push(new Error("boom: transport failure"));
    await expect(session).rejects.toThrow("boom: transport failure");

    // The loop's finally ran on the throw path and production teardown nulled
    // the transport.
    expect(adapter._streamWsForTest).toBeNull();

    const first = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(first.data.length).toBe(0);
    const second = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(second.data.length).toBe(0);
  });

  it("second session on the same adapter: stale terminal flag must not truncate the new call's first turn", async () => {
    const adapter = await connectedAdapter();
    // Session 1 completes silently: its finally marks the call ended and
    // enqueues the terminal sentinel. Drain it fully.
    await adapter._driveStreamSession(scriptedSocket([startFrame(), stopFrame()]));
    const s1 = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(s1.data.length).toBe(0);

    // Session 2 begins on the SAME connected adapter (a Twilio Media Streams
    // reconnect / back-to-back call) and is mid-call: started, nothing
    // buffered yet.
    const sock = controllableSocket();
    const session2 = adapter._driveStreamSession(sock);
    sock.push(startFrame("MZ695b", "CA695b"));
    await vi.waitFor(() => expect(adapter._streamWsForTest).not.toBeNull());

    // The regression this pins: if session 1's `_streamEnded` were still set
    // (flag scoped to the connection instead of the call), this receiveAudio
    // would synthesize an empty "end of call" sentinel INSTANTLY and the new
    // call's first agent turn would read as silent. With the per-call reset it
    // waits for the real audio that arrives next.
    const audioP = adapter.receiveAudio(RECV_TIMEOUT_S);
    // 800 bytes µ-law == the 100ms flush threshold, so the media branch
    // flushes immediately — no stop frame needed for the audio to land.
    sock.push(buildMediaFrame("MZ695b", new Uint8Array(800).fill(0x7f)));
    const audio = await audioP;
    expect(audio.data.length).toBeGreaterThan(0);

    // Session 2 then terminates normally and drains clean.
    sock.push(stopFrame());
    await session2;
    const tail = await adapter.receiveAudio(RECV_TIMEOUT_S);
    expect(tail.data.length).toBe(0);
  });
});

/**
 * The anti-drift gate (PR #697 P2 blocker). Everything above drives
 * `runStreamSession` by name; these tests drive nothing by name. They start the
 * adapter's REAL http+ws server, connect a REAL `ws` client to the REAL
 * `/twilio/stream` upgrade path — so `_handleStreamSocket` and `adaptWsSocket`
 * run — and let the REAL production consumer (`defaultVoiceCall` →
 * `drainAgentResponse`, what every agent turn runs) read the result.
 *
 * A fix that only works when a test calls the wrapper by name cannot pass here,
 * and these fail if `_handleStreamSocket` ever stops delegating to
 * `runStreamSession`.
 *
 * Where the JS pre-fix behaviour differs from the Python twin: `drainAgentResponse`
 * wraps its tail-silence `receiveAudio` in `try { … } catch { break }` (added by
 * #734), so a throw on the drain's *second* call is swallowed and silently
 * truncates the turn rather than crashing. The uncaught crash lands on the
 * drain's *first* `receiveAudio`, which has no such guard — i.e. whenever the
 * agent turn begins after the transport was already nulled. The two after-hangup
 * tests below pin exactly that, and are the ones that throw
 * `Error: no live media stream` against the pre-fix adapter.
 *
 * **The two layers are complements; neither subsumes the other.** Measured, not
 * assumed:
 * - Delete the drain-side guard in `receiveAudio` → only 2 of these 6 route tests
 *   go red (the after-hangup pair). The other 3 stay green because their *first*
 *   `receiveAudio` succeeds and `catch { break }` swallows the second-call throw.
 *   For those scenarios the wrapper-level suite above is the ONLY net.
 * - Delete the loop's sentinel `_enqueueInbound(...)` but keep `_markStreamEnded()`
 *   → all 5 wrapper-level tests still pass, while the two mid-drain route tests
 *   block to `responseTimeout` (~5.07s) — the original #695 hang, resurfaced. The
 *   wrapper layer cannot see the sentinel: a consumer that is not *already blocked*
 *   is served a synthesized empty chunk by the flag alone.
 *
 * So do not delete either suite believing the other covers it.
 */
describe("Twilio real /twilio/stream route (#695 P0, no seam)", () => {
  /** Poll until the route handler's `finally` has nulled the transport. */
  async function awaitTeardown(adapter: TwilioAgentAdapter): Promise<void> {
    await vi.waitFor(() => expect(adapter._streamWsForTest).toBeNull(), {
      timeout: 5_000,
    });
  }

  function openClient(adapter: TwilioAgentAdapter): Promise<WebSocket> {
    const url = `${adapter.localBaseUrl.replace(/^http:/, "ws:")}/twilio/stream`;
    return new Promise((resolve, reject) => {
      const client = new WebSocket(url);
      client.once("open", () => resolve(client));
      client.once("error", reject);
    });
  }

  /** No incoming audio → `defaultVoiceCall` goes straight to the drain. */
  function agentTurnInput(): Parameters<typeof defaultVoiceCall>[1] {
    return { newMessages: [] } as unknown as Parameters<typeof defaultVoiceCall>[1];
  }

  async function routeAdapter(): Promise<TwilioAgentAdapter> {
    const adapter = await connectedAdapter(); // starts the REAL http+ws server
    // Small drain budgets so a hang (the original #695 symptom) fails inside the
    // per-test timeout rather than stalling the suite.
    adapter.responseTimeout = 5;
    adapter.responseTailSilence = 0.5;
    return adapter;
  }

  async function startCall(adapter: TwilioAgentAdapter): Promise<WebSocket> {
    const client = await openClient(adapter);
    client.send(startFrame());
    await vi.waitFor(() => expect(adapter._streamSidForTest).toBe(STREAM_SID), {
      timeout: 5_000,
    });
    return client;
  }

  const audioBytes = (message: unknown): number => extractAudio(message)?.data.length ?? 0;

  it("silent stop mid-drain: the real route drains cleanly", async () => {
    const adapter = await routeAdapter();
    const client = await startCall(adapter);

    const call = defaultVoiceCall(adapter, agentTurnInput());
    // `defaultVoiceCall` reaches its first `receiveAudio` synchronously, so the
    // drain's queue waiter is already parked by the time the call above returns
    // its promise. This sleep is belt-and-braces: it keeps the test honest if a
    // future `await` is ever introduced ahead of the first receive.
    await sleep(50);
    client.send(stopFrame());

    const message = await call;
    expect(audioBytes(message)).toBe(0); // clean terminal — not a hang, not a crash
    await awaitTeardown(adapter);
    client.close();
  }, 15_000);

  it("socket close with no stop frame mid-drain: the real route drains cleanly", async () => {
    const adapter = await routeAdapter();
    const client = await startCall(adapter);

    const call = defaultVoiceCall(adapter, agentTurnInput());
    await sleep(50);
    client.close(); // Twilio drops the media socket, no stop frame

    const message = await call;
    expect(audioBytes(message)).toBe(0);
    await awaitTeardown(adapter);
  }, 15_000);

  it("normal audio turn: trailing PCM survives the real route's teardown", async () => {
    const adapter = await routeAdapter();
    const client = await startCall(adapter);

    const call = defaultVoiceCall(adapter, agentTurnInput());
    await sleep(50);
    // 160 bytes µ-law (~20ms) is under the 100ms batch threshold, so the "stop"
    // flush is what enqueues it: exactly the trailing-audio path.
    client.send(buildMediaFrame(STREAM_SID, new Uint8Array(160).fill(0x7f)));
    client.send(stopFrame());

    const message = await call;
    expect(audioBytes(message)).toBeGreaterThan(0); // audio reached the drain
    await awaitTeardown(adapter);
    client.close();
  }, 15_000);

  it("agent turn starting after hangup: drains cleanly instead of throwing", async () => {
    // The tightest form of the P0: the route already nulled the transport when
    // the drain makes its FIRST receiveAudio call — the next agent turn after
    // the caller hung up. Pre-fix this throws "no live media stream" out of
    // defaultVoiceCall, with the terminal sentinel unread in the queue.
    const adapter = await routeAdapter();
    const client = await startCall(adapter);

    client.send(stopFrame());
    await awaitTeardown(adapter);
    expect(adapter._streamSidForTest).toBeUndefined();

    const message = await defaultVoiceCall(adapter, agentTurnInput());
    expect(audioBytes(message)).toBe(0);
    client.close();
  }, 15_000);

  it("an undrained terminal sentinel does not truncate the next call's first turn", async () => {
    // A call that ends while NO drain is running leaves its terminal sentinel
    // buffered. The next media-stream session on the same connected adapter must
    // not serve that stale empty chunk as its first turn's audio: `receiveAudio`
    // drains a non-empty queue without checking liveness, and `drainAgentResponse`
    // breaks on an empty chunk — so the new call's first agent turn would be
    // truncated to silence, its real audio stranded for the turn after.
    const adapter = await routeAdapter();
    // Agent 2 "thinks" for longer than tail silence before speaking, so a stale
    // first chunk closes the turn before the real audio can land.
    adapter.responseTailSilence = 0.2;

    // Session 1: caller hangs up between turns; nothing consumes the sentinel.
    const first = await startCall(adapter);
    first.send(stopFrame());
    await awaitTeardown(adapter);
    first.close();

    // Session 2: a Twilio reconnect / back-to-back call.
    const second = await startCall(adapter);
    const call = defaultVoiceCall(adapter, agentTurnInput());
    setTimeout(() => {
      // 800 bytes µ-law == the 100ms flush threshold: flushes immediately.
      second.send(buildMediaFrame(STREAM_SID, new Uint8Array(800).fill(0x7f)));
    }, 600);

    const message = await call;
    expect(audioBytes(message)).toBeGreaterThan(0); // real audio, not a stale sentinel
    second.close();
  }, 15_000);

  it("audio buffered before hangup is not lost when the turn starts after teardown", async () => {
    // Pre-fix the liveness assert fired before the queue was read, so this
    // audio was dropped on the floor along with the crash.
    const adapter = await routeAdapter();
    const client = await startCall(adapter);

    client.send(buildMediaFrame(STREAM_SID, new Uint8Array(160).fill(0x7f)));
    client.send(stopFrame());
    await awaitTeardown(adapter);

    const message = await defaultVoiceCall(adapter, agentTurnInput());
    expect(audioBytes(message)).toBeGreaterThan(0); // recovered, not lost
    client.close();
  }, 15_000);
});
