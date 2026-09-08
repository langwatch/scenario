/**
 * Shared a-leg test harness (scenario#762): a REST spy, an adapter factory, a
 * scripted in-memory media socket, and the two ways to drive them.
 *
 * Not a test file (vitest collects `*.test.ts` only) — it exists so the nonce
 * tests, the DTMF guard and the frame-loop tripwire drive the a-leg path
 * through ONE socket double instead of three divergent ones. Mirrors the
 * helpers `python/tests/voice/test_twilio_stream_auth.py` exposes to its
 * siblings.
 */

import { Buffer } from "node:buffer";

import { expect, vi } from "vitest";

import { TwilioAgentAdapter } from "../twilio";
import type { MediaStreamWebSocket } from "../twilio-server";
import { TwilioRESTHelper } from "../twilio-shared";

/** The SID the stub REST helper returns — the call a-leg mode originated. */
export const ORIGINATED_CALL_SID = "CAoriginated";
export const NONCE_RE = /<Parameter name="nonce" value="([^"]+)"\/>/;

export type SpyRest = TwilioRESTHelper & {
  placeCallArgs: Array<{ to: string; from: string; twiml: string }>;
  /** `[callSid, tones]` per sendDtmfOnCall — the TwiML-replacing POST a-leg must never issue. */
  dtmfCalls: Array<[string, string]>;
};

export function spyRest(): SpyRest {
  const stub = new TwilioRESTHelper("ACtest", "secret") as SpyRest;
  stub.placeCallArgs = [];
  stub.dtmfCalls = [];
  stub.resolvePhoneNumberSid = async () => "PN1234567890abcdef";
  stub.readVoiceUrl = async () => null;
  stub.writeVoiceUrl = async () => undefined;
  stub.placeCall = async (a: { to: string; from: string; twiml: string }) => {
    stub.placeCallArgs.push(a);
    return ORIGINATED_CALL_SID;
  };
  stub.sendDtmfOnCall = async (callSid: string, tones: string) => {
    stub.dtmfCalls.push([callSid, tones]);
  };
  return stub;
}

export function makeAdapter(rest: SpyRest): TwilioAgentAdapter {
  return new TwilioAgentAdapter({
    accountSid: "ACtest",
    authToken: "secret",
    phoneNumber: "+14155551234",
    publicBaseUrl: "https://example.test",
    validateSignature: false,
    // a-leg destinations are deny-by-default (#762 guardrail (c)), so every
    // a-leg test needs the number it dials on the allowlist. The allowlist
    // tests build their own adapters instead.
    allowedCallees: ["+447911123456"],
    rest,
  });
}

export function startFrame(opts: {
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

export type ScriptedSocket = MediaStreamWebSocket & {
  closed: boolean;
  sent: string[];
};

/**
 * Media-stream socket double: serves `frames` in order, then parks.
 *
 * Parking (rather than resolving `null`) models a socket Twilio holds open, so a
 * test can assert that a rejected socket is CLOSED by the loop rather than
 * merely having run out of frames.
 */
export function scriptedSocket(frames: string[]): ScriptedSocket {
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
export async function drive(
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
export async function startALegCall(
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
export async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const pendingMarker = Symbol("pending");
  const winner = await Promise.race([
    promise.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve(pendingMarker), 20)),
  ]);
  return winner === pendingMarker;
}
