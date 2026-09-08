/**
 * A-leg max call duration (scenario#762 Slice 3, guardrail (b)).
 *
 * B-leg mode holds the originator leg with `<Pause length="120"/>`, which caps
 * the call for free. A-leg mode replaced that with `<Connect>`, under which the
 * call lives exactly as long as the WebSocket — so a hung or killed executor
 * would keep a billing PSTN call open indefinitely. Two independent mechanisms
 * restore the ceiling: Twilio's own `TimeLimit` on `Calls.create` (AC12 — the
 * load-bearing half, it fires even when this process is gone) and an
 * adapter-side wall-clock timer that hangs the call up via REST and closes the
 * socket (AC7).
 *
 * Binds AC7 and AC12 of `specs/voice-twilio-a-leg-external.feature`. Mirrors
 * `python/tests/voice/test_twilio_call_duration.py`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { TwilioAgentAdapter } from "../twilio";
import type { MediaStreamWebSocket } from "../twilio-server";
import {
  DEFAULT_MAX_CALL_DURATION_SECONDS,
  MAX_CALL_DURATION_CAP_SECONDS,
  TwilioRESTHelper,
} from "../twilio-shared";

/** The SID `spyRest.placeCall` returns — the call a-leg mode originated. */
const ORIGINATED_CALL_SID = "CA" + "1".repeat(32);

type SpyRest = TwilioRESTHelper & {
  placeCallArgs: Array<{
    to: string;
    from: string;
    twiml: string;
    timeLimitSeconds?: number;
  }>;
  /** Call SIDs passed to endCall — the watchdog's REST teardown. */
  endCalls: string[];
};

function spyRest(): SpyRest {
  const stub = new TwilioRESTHelper("ACtest", "secret") as SpyRest;
  stub.placeCallArgs = [];
  stub.endCalls = [];
  stub.resolvePhoneNumberSid = async () => "PN1234567890abcdef";
  stub.readVoiceUrl = async () => null;
  stub.writeVoiceUrl = async () => undefined;
  stub.placeCall = async (a: {
    to: string;
    from: string;
    twiml: string;
    timeLimitSeconds?: number;
  }) => {
    stub.placeCallArgs.push(a);
    return ORIGINATED_CALL_SID;
  };
  stub.endCall = async (callSid: string) => {
    stub.endCalls.push(callSid);
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
    // a-leg destinations are deny-by-default (#762 guardrail (c)), so every
    // a-leg test needs the number it dials on the allowlist. The allowlist
    // tests build their own adapters instead.
    allowedCallees: ["+447911123456"],
    rest,
  });
}

/**
 * Stand-in for the adapter's `_awaitMaxDuration` seam: the test decides when
 * time is up, so expiry is driven by `release()` rather than a real wall clock.
 */
function controlledExpiry(): {
  ms: number | undefined;
  armed: Promise<void>;
  release: () => void;
  fn: (ms: number) => Promise<void>;
} {
  let armedResolve!: () => void;
  const armed = new Promise<void>((resolve) => (armedResolve = resolve));
  let releaseResolve!: () => void;
  const released = new Promise<void>((resolve) => (releaseResolve = resolve));
  const state = {
    ms: undefined as number | undefined,
    armed,
    release: () => releaseResolve(),
    fn: async (ms: number) => {
      state.ms = ms;
      armedResolve();
      await released;
    },
  };
  return state;
}

function installExpiry(
  adapter: TwilioAgentAdapter,
  expiry: { fn: (ms: number) => Promise<void> },
): void {
  (adapter as unknown as { _awaitMaxDuration: (ms: number) => Promise<void> })._awaitMaxDuration =
    expiry.fn;
}

/**
 * Wait for the watchdog to arm, failing fast if it never does.
 *
 * Without the bound, an adapter that forgets to arm the timer hangs the test
 * instead of failing it.
 */
async function armed(expiry: { armed: Promise<void> }): Promise<void> {
  await Promise.race([
    expiry.armed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("max-duration timer was never armed")), 2_000),
    ),
  ]);
}

/**
 * Let a released expiry continuation run to completion.
 *
 * A cancelled watchdog produces no observable effect, so there is nothing to
 * `waitFor` — two macrotask ticks are what separates "the handler ran and did
 * nothing" from "the handler had not resumed yet".
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function endedReason(adapter: TwilioAgentAdapter): string {
  return (adapter as unknown as { _streamEndedReason: string })._streamEndedReason;
}

/** Media-stream socket double: records that it was closed. */
function fakeSocket(): MediaStreamWebSocket & { closed: boolean } {
  return {
    closed: false,
    send() {
      /* no outbound audio in these tests */
    },
    receiveText(): Promise<string | null> {
      return new Promise<string | null>(() => {
        /* parked: the socket stays open */
      });
    },
    close() {
      this.closed = true;
    },
  };
}

describe("TwilioAgentAdapter a-leg max call duration", () => {
  let openAdapter: TwilioAgentAdapter | null = null;

  afterEach(async () => {
    if (openAdapter) {
      await openAdapter.disconnect();
      openAdapter = null;
    }
  });

  async function connected(rest: SpyRest): Promise<TwilioAgentAdapter> {
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    adapter._signalStreamConnected(); // a-leg's stream still comes to us
    return adapter;
  }

  // -------------------------------------------------------------- AC12

  it("AC12: places the configured time limit in the Calls.create request", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    await adapter.placeCall({
      to: "+447911123456",
      attachStream: "a-leg",
      maxCallDurationSeconds: 120,
    });
    expect(rest.placeCallArgs[0].timeLimitSeconds).toBe(120);
  });

  it("defaults the time limit when the caller names none", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    await adapter.placeCall({ to: "+447911123456", attachStream: "a-leg" });
    expect(rest.placeCallArgs[0].timeLimitSeconds).toBe(DEFAULT_MAX_CALL_DURATION_SECONDS);
  });

  it("throws before origination when the request exceeds the global cap", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    await expect(
      adapter.placeCall({
        to: "+447911123456",
        attachStream: "a-leg",
        maxCallDurationSeconds: MAX_CALL_DURATION_CAP_SECONDS + 1,
      }),
    ).rejects.toThrow(new RegExp(`${MAX_CALL_DURATION_CAP_SECONDS}s cap`));
    expect(rest.placeCallArgs).toEqual([]);
  });

  it("throws before origination on a non-positive duration", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    await expect(
      adapter.placeCall({
        to: "+447911123456",
        attachStream: "a-leg",
        maxCallDurationSeconds: 0,
      }),
    ).rejects.toThrow(/positive number of seconds/);
    expect(rest.placeCallArgs).toEqual([]);
  });

  it("rejects maxCallDurationSeconds outside a-leg mode", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    await expect(
      adapter.placeCall({ to: "+14155557777", maxCallDurationSeconds: 60 }),
    ).rejects.toThrow(/attachStream="a-leg"/);
    expect(rest.placeCallArgs).toEqual([]);
  });

  // --------------------------------------------------------------- AC7

  it("AC7: on expiry it ends the originated call via REST and closes the WS", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    const expiry = controlledExpiry();
    installExpiry(adapter, expiry);

    await adapter.placeCall({
      to: "+447911123456",
      attachStream: "a-leg",
      timeoutMs: 120_000,
      maxCallDurationSeconds: 42,
    });
    const ws = fakeSocket();
    adapter._setStreamWs(ws);

    await armed(expiry);
    // The two clocks are independent: the timer got the max-duration value, not
    // placeCall's connect timeout.
    expect(expiry.ms).toBe(42_000);
    expiry.release();

    await vi.waitFor(() => expect(rest.endCalls).toEqual([ORIGINATED_CALL_SID]));
    expect(ws.closed).toBe(true);
    expect(endedReason(adapter)).toBe("max_duration");
  });

  it("disconnect() disarms the timer, so a later expiry hangs up nothing", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    const expiry = controlledExpiry();
    installExpiry(adapter, expiry);

    await adapter.placeCall({
      to: "+447911123456",
      attachStream: "a-leg",
      maxCallDurationSeconds: 42,
    });
    await armed(expiry);

    await adapter.disconnect();
    openAdapter = null;
    expiry.release();
    await flush();

    expect(rest.endCalls).toEqual([]);
    // The expiry handler stamps "max_duration" before it calls REST, so an
    // untouched reason proves the handler never ran — not merely that REST was
    // unreachable after teardown.
    expect(endedReason(adapter)).toBe("none");
  });

  it("stream end disarms the timer, so an ended call cannot be hung up again", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    const expiry = controlledExpiry();
    installExpiry(adapter, expiry);

    await adapter.placeCall({
      to: "+447911123456",
      attachStream: "a-leg",
      maxCallDurationSeconds: 42,
    });
    await armed(expiry);

    const nonce = adapter._streamNonceForServer;
    const frames = [
      JSON.stringify({
        event: "start",
        start: {
          streamSid: "MZ762",
          callSid: ORIGINATED_CALL_SID,
          customParameters: { nonce },
        },
      }),
      JSON.stringify({ event: "stop" }),
    ];
    await adapter._driveMediaStream({
      send() {},
      receiveText: () => Promise.resolve(frames.shift() ?? null),
      close() {},
    });

    expiry.release();
    await flush();
    expect(rest.endCalls).toEqual([]);
    expect(endedReason(adapter)).toBe("stop");
  });

  it("a second placeCall replaces the first call's timer", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    const first = controlledExpiry();
    installExpiry(adapter, first);
    await adapter.placeCall({
      to: "+447911123456",
      attachStream: "a-leg",
      maxCallDurationSeconds: 42,
    });
    await armed(first);

    const second = controlledExpiry();
    installExpiry(adapter, second);
    await adapter.placeCall({
      to: "+447911123456",
      attachStream: "a-leg",
      maxCallDurationSeconds: 42,
    });
    await armed(second);

    first.release();
    await flush();
    expect(rest.endCalls).toEqual([]);
    expect(endedReason(adapter)).toBe("none");
  });
});

// ------------------------------------------- REST wire body (AC12, real helper)

/** Capture what the helper actually puts on the wire. */
function recordingFetch(): {
  calls: Array<{ url: string; body: string }>;
  impl: typeof fetch;
} {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = (async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body ?? "" });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sid: ORIGINATED_CALL_SID }),
    };
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("TwilioRESTHelper call-duration wire body", () => {
  it("AC12: placeCall puts the configured TimeLimit in the Calls.create body", async () => {
    const { calls, impl } = recordingFetch();
    await new TwilioRESTHelper("ACtest", "secret", impl).placeCall({
      to: "+447911123456",
      from: "+14155551234",
      twiml: "<Response/>",
      timeLimitSeconds: 300,
    });
    expect(calls[0].url).toMatch(/\/Calls\.json$/);
    expect(new URLSearchParams(calls[0].body).get("TimeLimit")).toBe("300");
  });

  it("omits TimeLimit entirely when unset, keeping b-leg's body byte-identical", async () => {
    const { calls, impl } = recordingFetch();
    await new TwilioRESTHelper("ACtest", "secret", impl).placeCall({
      to: "+14155557777",
      from: "+14155551234",
      twiml: "<Response/>",
    });
    expect(new URLSearchParams(calls[0].body).has("TimeLimit")).toBe(false);
  });

  it("endCall posts Status=completed against the call SID", async () => {
    const { calls, impl } = recordingFetch();
    await new TwilioRESTHelper("ACtest", "secret", impl).endCall(ORIGINATED_CALL_SID);
    expect(calls[0].url).toMatch(new RegExp(`/Calls/${ORIGINATED_CALL_SID}\\.json$`));
    expect(new URLSearchParams(calls[0].body).get("Status")).toBe("completed");
  });
});
