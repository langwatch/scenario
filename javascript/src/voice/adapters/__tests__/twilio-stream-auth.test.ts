/**
 * A-leg media-stream WebSocket authentication (scenario#762 Slice 2, guardrail (a)).
 *
 * In b-leg mode the signed `POST /twilio/voice` webhook precedes the socket, so
 * the socket inherits that trust. In a-leg mode the socket is the ONLY inbound
 * signal, so a leaked tunnel URL would otherwise be audio injection into a live
 * PSTN call. `placeCall` mints a per-call CSPRNG nonce into the origination
 * TwiML and the media loop closes any socket that cannot present it.
 *
 * Binds AC5 (nonce), AC6 (callSid correlation) and AC13 (per-call nonce
 * entropy) of `specs/voice-twilio-a-leg-external.feature`. Mirrors
 * `python/tests/voice/test_twilio_stream_auth.py`.
 */

import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TwilioAgentAdapter } from "../twilio";
import type { MediaStreamWebSocket } from "../twilio-server";
import { STREAM_NONCE_HEX_LEN, TwilioRESTHelper } from "../twilio-shared";

/** The SID the stub REST helper returns — the call a-leg mode originated. */
const ORIGINATED_CALL_SID = "CAoriginated";
const NONCE_RE = /<Parameter name="nonce" value="([^"]+)"\/>/;

type SpyRest = TwilioRESTHelper & {
  placeCallArgs: Array<{ to: string; from: string; twiml: string }>;
};

function spyRest(): SpyRest {
  const stub = new TwilioRESTHelper("ACtest", "secret") as SpyRest;
  stub.placeCallArgs = [];
  stub.resolvePhoneNumberSid = async () => "PN1234567890abcdef";
  stub.readVoiceUrl = async () => null;
  stub.writeVoiceUrl = async () => undefined;
  stub.placeCall = async (a: { to: string; from: string; twiml: string }) => {
    stub.placeCallArgs.push(a);
    return ORIGINATED_CALL_SID;
  };
  stub.sendDtmfOnCall = async () => undefined;
  return stub;
}

function makeAdapter(rest: SpyRest): TwilioAgentAdapter {
  return new TwilioAgentAdapter({
    accountSid: "ACtest",
    authToken: "secret",
    phoneNumber: "+14155551234",
    publicBaseUrl: "https://example.test",
    validateSignature: false,
    rest,
  });
}

function startFrame(opts: {
  nonce?: string;
  callSid?: string;
  streamSid?: string;
}): string {
  const start: Record<string, unknown> = {
    streamSid: opts.streamSid ?? "MZ762",
    callSid: opts.callSid ?? ORIGINATED_CALL_SID,
  };
  if (opts.nonce !== undefined) start.customParameters = { nonce: opts.nonce };
  return JSON.stringify({ event: "start", start });
}

/**
 * Media-stream socket double: serves `frames` in order, then parks.
 *
 * Parking (rather than resolving `null`) models a socket Twilio holds open, so a
 * test can assert that a rejected socket is CLOSED by the loop rather than
 * merely having run out of frames.
 */
function scriptedSocket(frames: string[]): MediaStreamWebSocket & {
  closed: boolean;
  sent: string[];
} {
  const queue = [...frames];
  return {
    closed: false,
    sent: [] as string[],
    send(data: string | Uint8Array) {
      this.sent.push(
        typeof data === "string" ? data : Buffer.from(data).toString("utf-8"),
      );
    },
    receiveText(): Promise<string | null> {
      const head = queue.shift();
      if (head !== undefined) return Promise.resolve(head);
      return new Promise<string | null>(() => {
        /* parked: the socket stays open */
      });
    },
    close() {
      this.closed = true;
    },
  };
}

/**
 * Run the media loop over `ws` until it returns or parks on the socket.
 *
 * A rejected socket makes the loop return on its own; an accepted one parks in
 * `receiveText` waiting for the next frame. Both are expected terminals here —
 * the assertions are on adapter state, not on how the loop exited.
 */
async function drive(
  adapter: TwilioAgentAdapter,
  ws: MediaStreamWebSocket,
): Promise<void> {
  await Promise.race([
    adapter._driveMediaStream(ws),
    new Promise<void>((resolve) => setTimeout(resolve, 50)),
  ]);
}

/**
 * Start an a-leg `placeCall` WITHOUT awaiting it, and return the nonce it put in
 * the origination TwiML plus the still-pending call promise.
 *
 * `placeCall` only resolves once the media stream connects, so the promise IS
 * the stream-connected signal: a rejected socket leaves it pending, and the
 * socket that authenticates is the one that settles it. That is the JS twin of
 * Python's `_stream_connected.is_set()` assertion — Node has no observable
 * "already resolved" flag on a bare promise.
 */
async function startALegCall(
  adapter: TwilioAgentAdapter,
  rest: SpyRest,
): Promise<{ nonce: string; call: Promise<void> }> {
  const call = adapter.placeCall({
    to: "+447911123456",
    attachStream: "a-leg",
    timeoutMs: 2_000,
  });
  // Let the origination REST call land so the TwiML is captured.
  await vi.waitUntil(() => rest.placeCallArgs.length > 0, { timeout: 1_000 });
  const twiml = rest.placeCallArgs[rest.placeCallArgs.length - 1].twiml;
  const match = NONCE_RE.exec(twiml);
  expect(match, "a-leg origination TwiML carries no nonce Parameter").not.toBeNull();
  return { nonce: (match as RegExpExecArray)[1], call };
}

/** Has `promise` settled by the next macrotask tick? */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const pendingMarker = Symbol("pending");
  const winner = await Promise.race([
    promise.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve(pendingMarker), 20)),
  ]);
  return winner === pendingMarker;
}

describe("TwilioAgentAdapter a-leg media-stream authentication", () => {
  let openAdapter: TwilioAgentAdapter | null = null;

  afterEach(async () => {
    if (openAdapter) {
      await openAdapter.disconnect();
      openAdapter = null;
    }
  });

  it("AC5: a wrong-nonce socket is closed, never connects, and the next correct one does", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    const { nonce, call } = await startALegCall(adapter, rest);

    const attacker = scriptedSocket([startFrame({ nonce: "not-the-nonce" })]);
    await drive(adapter, attacker);
    expect(attacker.closed).toBe(true);
    expect(await isPending(call)).toBe(true); // stream-connected never fired
    expect(adapter._streamWsForTest).toBeNull(); // never adopted as our transport

    const genuine = scriptedSocket([startFrame({ nonce })]);
    await drive(adapter, genuine);
    expect(genuine.closed).toBe(false);
    await call; // the correct-nonce socket is the one that connects
    expect(adapter._streamWsForTest).toBe(genuine);
  });

  it("AC5: omitting the nonce Parameter is a rejection, not a bypass", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    const { nonce, call } = await startALegCall(adapter, rest);

    const ws = scriptedSocket([startFrame({})]);
    await drive(adapter, ws);
    expect(ws.closed).toBe(true);
    expect(await isPending(call)).toBe(true);

    // Settle the dial so the pending placeCall does not outlive the test.
    await drive(adapter, scriptedSocket([startFrame({ nonce })]));
    await call;
  });

  it("AC6: a start frame for another callSid is ignored; the matching one connects", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    const { nonce, call } = await startALegCall(adapter, rest);
    expect(adapter._callSidForServer).toBe(ORIGINATED_CALL_SID);

    const stale = scriptedSocket([startFrame({ nonce, callSid: "CAsomeoneelse" })]);
    await drive(adapter, stale);
    expect(await isPending(call)).toBe(true);
    expect(adapter._streamWsForTest).toBeNull();

    const genuine = scriptedSocket([startFrame({ nonce })]);
    await drive(adapter, genuine);
    await call; // resolves exactly once, on the matching SID
    expect(adapter._streamSidForTest).toBe("MZ762");
  });

  it("AC13: two a-leg originations mint different nonces of the chosen shape", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    // Both dials only need to REACH origination; pre-resolve the connect signal.
    adapter._signalStreamConnected();

    await adapter.placeCall({ to: "+447911123456", attachStream: "a-leg" });
    // placeCall is once-per-mode; re-arm for a second dial.
    (adapter as unknown as { _mode: string })._mode = "idle";
    await adapter.placeCall({ to: "+447911123456", attachStream: "a-leg" });

    const nonces = rest.placeCallArgs.map((a) => {
      const match = NONCE_RE.exec(a.twiml);
      expect(match).not.toBeNull();
      return (match as RegExpExecArray)[1];
    });
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
    for (const nonce of nonces) {
      expect(nonce).toHaveLength(STREAM_NONCE_HEX_LEN);
      expect(nonce).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("b-leg mints no nonce, emits no <Parameter>, and still connects un-gated", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    const call = adapter.placeCall({ to: "+14155557777" }); // default b-leg
    await vi.waitUntil(() => rest.placeCallArgs.length > 0, { timeout: 1_000 });
    expect(rest.placeCallArgs[0].twiml).not.toContain("<Parameter");
    expect(adapter._streamNonceForServer).toBeUndefined();

    // No nonce, and a callSid that is not the originated one: b-leg is un-gated
    // (its media stream rides the CALLEE's leg, which has its own SID), so this
    // socket connects exactly as it does today.
    const ws = scriptedSocket([startFrame({ callSid: "CAsomeoneelse" })]);
    await drive(adapter, ws);
    expect(ws.closed).toBe(false);
    await call;
    expect(adapter._streamWsForTest).toBe(ws);
  });
});
