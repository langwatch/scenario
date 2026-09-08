/**
 * Shared a-leg test harness (scenario#762): a REST spy, an adapter factory, a
 * scripted in-memory media socket, and the two ways to drive them.
 *
 * Not a test file (vitest collects `*.test.ts` only) — it exists so the nonce
 * tests, the DTMF guard, the frame-loop tripwire, the call-duration suite and
 * the destination guard drive the a-leg path through ONE socket double and ONE
 * REST spy instead of five divergent ones. A per-file copy is not merely
 * duplication: `ORIGINATED_CALL_SID` had drifted to two different values, and a
 * test that mixed helpers across files silently took the media loop's
 * `callSid !== originatedCallSid` "ignore" branch — passing for exactly the
 * wrong reason. Direct twin of `python/tests/voice/a_leg_harness.py`.
 */

import { Buffer } from "node:buffer";

import { expect, vi } from "vitest";

import { TwilioAgentAdapter } from "../twilio";
import type { MediaStreamWebSocket } from "../twilio-server";
import { TwilioRESTHelper, type TunnelReadiness } from "../twilio-shared";

/**
 * The SID the stub REST helper returns — the call a-leg mode originated. The
 * realistic `CA` + 32 hex-ish characters shape, and the same value Python uses.
 */
export const ORIGINATED_CALL_SID = "CA" + "1".repeat(32);
/**
 * The one external number the a-leg tests may dial. Ofcom's drama range, which
 * is permanently unassignable — a copy-paste into a live config dials nobody.
 */
export const A_LEG_DESTINATION = "+447700900123";
export const NONCE_RE = /<Parameter name="nonce" value="([^"]+)"\/>/;

/** Arguments `TwilioRESTHelper.placeCall` was called with. */
export interface PlaceCallArgs {
  to: string;
  from: string;
  twiml: string;
  timeLimitSeconds?: number;
}

export type SpyRest = TwilioRESTHelper & {
  placeCallArgs: PlaceCallArgs[];
  /** `[callSid, tones]` per sendDtmfOnCall — the TwiML-replacing POST a-leg must never issue. */
  dtmfCalls: Array<[string, string]>;
  /** Call SIDs passed to endCall — the watchdog's REST teardown. */
  endCalls: string[];
  /** Every callee-touching REST call in order, so tests can assert its absence. */
  restCallLog: Array<[string, unknown[]]>;
};

export function spyRest(): SpyRest {
  const stub = new TwilioRESTHelper("ACtest", "secret") as SpyRest;
  stub.placeCallArgs = [];
  stub.dtmfCalls = [];
  stub.endCalls = [];
  stub.restCallLog = [];
  stub.resolvePhoneNumberSid = async (number: string) => {
    stub.restCallLog.push(["resolvePhoneNumberSid", [number]]);
    return "PN1234567890abcdef";
  };
  stub.readVoiceUrl = async (sid: string) => {
    stub.restCallLog.push(["readVoiceUrl", [sid]]);
    return null;
  };
  stub.writeVoiceUrl = async (sid: string, url: string) => {
    stub.restCallLog.push(["writeVoiceUrl", [sid, url]]);
  };
  stub.placeCall = async (args: PlaceCallArgs) => {
    stub.placeCallArgs.push(args);
    return ORIGINATED_CALL_SID;
  };
  stub.endCall = async (callSid: string) => {
    stub.endCalls.push(callSid);
  };
  stub.sendDtmfOnCall = async (callSid: string, tones: string) => {
    stub.dtmfCalls.push([callSid, tones]);
  };
  return stub;
}

/**
 * A connected-ready adapter over `rest`.
 *
 * `allowedCallees` defaults to the one a-leg destination, because a-leg
 * destinations are deny-by-default (#762 guardrail (c)) and every a-leg test
 * needs it; the allowlist tests pass their own (including `undefined`, to
 * exercise the default-deny path).
 */
export function makeAdapter(
  rest: SpyRest,
  opts: { allowedCallees?: readonly string[]; tunnel?: TunnelReadiness } = {},
): TwilioAgentAdapter {
  return new TwilioAgentAdapter({
    accountSid: "ACtest",
    authToken: "secret",
    phoneNumber: "+14155551234",
    publicBaseUrl: "https://example.test",
    validateSignature: false,
    allowedCallees: "allowedCallees" in opts ? opts.allowedCallees : [A_LEG_DESTINATION],
    tunnelReadiness: opts.tunnel,
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
  /** Resolves once the loop asks for a frame past the end of `frames`. */
  parked: Promise<void>;
};

/**
 * Media-stream socket double: serves `frames` in order, then parks.
 *
 * Parking (rather than resolving `null`) models a socket Twilio holds open, so a
 * test can assert that a rejected socket is CLOSED by the loop rather than
 * merely having run out of frames. `closeAtEnd` instead models the client
 * hanging up — what an attacker who connects and immediately closes looks like
 * on the wire.
 *
 * `parked` settles once the loop asks for a frame that is not there, i.e. once
 * every scripted frame has been fully handled. That is the observable
 * {@link drive} waits on, so no test has to guess at a sleep.
 */
export function scriptedSocket(
  frames: string[],
  opts: { closeAtEnd?: boolean } = {},
): ScriptedSocket {
  const queue = [...frames];
  let signalParked!: () => void;
  const parked = new Promise<void>((resolve) => (signalParked = resolve));
  return {
    closed: false,
    sent: [] as string[],
    parked,
    send(data: string | Uint8Array) {
      this.sent.push(
        typeof data === "string" ? data : Buffer.from(data).toString("utf-8"),
      );
    },
    receiveText(): Promise<string | null> {
      const head = queue.shift();
      if (head !== undefined) return Promise.resolve(head);
      signalParked();
      if (opts.closeAtEnd) return Promise.resolve(null);
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
 * Run the media stream over `ws` until it settles, leaving it running.
 *
 * Waits on the OBSERVABLE — the loop returning, or the socket having served
 * every scripted frame — rather than on a fixed sleep, so a slow machine cannot
 * silently truncate the run; the ceiling is a failure bound, not the expected
 * wait. An accepted socket is still the adapter's live transport when this
 * resolves, which is what lets the frame-loop and DTMF suites keep asserting
 * against a live stream.
 *
 * `production: true` drives `runStreamSession` — the real `/twilio/stream`
 * entry, including the `finally` that nulls the adapter's transport — instead of
 * the bare loop.
 */
export async function drive(
  adapter: TwilioAgentAdapter,
  ws: ScriptedSocket,
  opts: { production?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const run = opts.production
    ? adapter._driveStreamSession(ws)
    : adapter._driveMediaStream(ws);
  const settled = Symbol("settled");
  const winner = await Promise.race([
    run.then(() => settled),
    ws.parked.then(() => settled),
    new Promise((resolve) => setTimeout(resolve, opts.timeoutMs ?? 5_000)),
  ]);
  expect(
    winner,
    "media stream neither settled nor consumed its scripted frames",
  ).toBe(settled);
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
    to: A_LEG_DESTINATION,
    attachStream: "a-leg",
    timeoutMs: 10_000,
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
