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
import {
  DEFAULT_MAX_CALL_DURATION_SECONDS,
  MAX_CALL_DURATION_CAP_SECONDS,
  TwilioRESTHelper,
} from "../twilio-shared";
// One shared REST spy, adapter factory and socket double across every a-leg
// suite — see `a-leg-harness.ts`.
import {
  A_LEG_DESTINATION,
  dialAndConnect,
  drive,
  makeAdapter,
  NONCE_RE,
  ORIGINATED_CALL_SID,
  scriptedSocket,
  spyRest,
  startFrame,
  type SpyRest,
} from "./a-leg-harness";

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
    await dialAndConnect(
      adapter,
      adapter.placeCall({
        to: A_LEG_DESTINATION,
        attachStream: "a-leg",
        maxCallDurationSeconds: 120,
      }),
    );
    expect(rest.placeCallArgs[0].timeLimitSeconds).toBe(120);
  });

  it("defaults the time limit when the caller names none", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    await dialAndConnect(
      adapter,
      adapter.placeCall({ to: A_LEG_DESTINATION, attachStream: "a-leg" }),
    );
    expect(rest.placeCallArgs[0].timeLimitSeconds).toBe(DEFAULT_MAX_CALL_DURATION_SECONDS);
  });

  it("throws before origination when the request exceeds the global cap", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    await expect(
      adapter.placeCall({
        to: A_LEG_DESTINATION,
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
        to: A_LEG_DESTINATION,
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

    await dialAndConnect(
      adapter,
      adapter.placeCall({
        to: A_LEG_DESTINATION,
        attachStream: "a-leg",
        timeoutMs: 120_000,
        maxCallDurationSeconds: 42,
      }),
    );
    const ws = scriptedSocket([]);
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

    await dialAndConnect(
      adapter,
      adapter.placeCall({
        to: A_LEG_DESTINATION,
        attachStream: "a-leg",
        maxCallDurationSeconds: 42,
      }),
    );
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

    await dialAndConnect(
      adapter,
      adapter.placeCall({
        to: A_LEG_DESTINATION,
        attachStream: "a-leg",
        maxCallDurationSeconds: 42,
      }),
    );
    await armed(expiry);

    const nonce = adapter._streamNonceForServer;
    await drive(
      adapter,
      scriptedSocket([startFrame({ nonce }), JSON.stringify({ event: "stop" })]),
    );

    expiry.release();
    await flush();
    expect(rest.endCalls).toEqual([]);
    expect(endedReason(adapter)).toBe("stop");
  });

  // --------------------------------------------- stream-connect timeout

  it("an a-leg stream-connect timeout hangs the originated call up", async () => {
    // The ordinary a-leg failure path must not bill for the whole cap: when the
    // media stream never connects, the call is ALREADY originated and the
    // watchdog armed — so without an explicit hangup the caller gets their
    // timeout while Twilio keeps the PSTN call alive to maxCallDurationSeconds.
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    // Never signal stream-connected — nothing will drive a socket.
    await expect(
      adapter.placeCall({
        to: A_LEG_DESTINATION,
        attachStream: "a-leg",
        timeoutMs: 20,
      }),
    ).rejects.toThrow();
    expect(rest.endCalls).toEqual([ORIGINATED_CALL_SID]);
  });

  it("a b-leg stream-connect timeout hangs nothing up", async () => {
    // b-leg holds the originator leg with <Pause>, which bounds it already — the
    // hangup stays a-leg-only so b-leg's failure path is byte-for-byte unchanged.
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    await expect(
      adapter.placeCall({ to: "+14155557777", timeoutMs: 20 }),
    ).rejects.toThrow();
    expect(rest.endCalls).toEqual([]);
  });

  it("a second placeCall replaces the first call's timer", async () => {
    const rest = spyRest();
    const adapter = await connected(rest);
    const first = controlledExpiry();
    installExpiry(adapter, first);
    await dialAndConnect(
      adapter,
      adapter.placeCall({
        to: A_LEG_DESTINATION,
        attachStream: "a-leg",
        maxCallDurationSeconds: 42,
      }),
    );
    await armed(first);

    const second = controlledExpiry();
    installExpiry(adapter, second);
    await dialAndConnect(
      adapter,
      adapter.placeCall({
        to: A_LEG_DESTINATION,
        attachStream: "a-leg",
        maxCallDurationSeconds: 42,
      }),
    );
    await armed(second);

    first.release();
    await flush();
    expect(rest.endCalls).toEqual([]);
    expect(endedReason(adapter)).toBe("none");
  });

  it("#762 P2: an expired watchdog in flight does not close a newer call's socket", async () => {
    // Call A's watchdog fires and its hang-up REST call is IN FLIGHT when call B
    // takes over. The pre-await generation check already passed for A, so A's
    // handler keeps running; after its hang-up resolves it must close only the
    // EXPIRED call's socket — never whatever socket is live now (B's).
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;

    const aSid = "CA" + "a".repeat(32);
    const bSid = "CB" + "b".repeat(32);
    const sids = [aSid, bSid];
    let placeIdx = 0;
    rest.placeCall = async (args) => {
      rest.placeCallArgs.push(args);
      return sids[placeIdx++];
    };
    // Hold A's hang-up REST response until the test releases it.
    let releaseEnd!: () => void;
    const endHeld = new Promise<void>((resolve) => (releaseEnd = resolve));
    rest.endCall = async (callSid: string) => {
      rest.endCalls.push(callSid);
      if (callSid === aSid) await endHeld;
    };

    // 1. Place a-leg call A and connect its socket; arm its watchdog.
    const expiryA = controlledExpiry();
    installExpiry(adapter, expiryA);
    const callA = adapter.placeCall({
      to: A_LEG_DESTINATION,
      attachStream: "a-leg",
      timeoutMs: 120_000,
      maxCallDurationSeconds: 42,
    });
    await vi.waitUntil(() => rest.placeCallArgs.length === 1, { timeout: 1_000 });
    const nonceA = NONCE_RE.exec(rest.placeCallArgs[0].twiml)![1];
    await drive(adapter, scriptedSocket([startFrame({ nonce: nonceA, callSid: aSid })]), {
      production: true,
    });
    await callA;
    await armed(expiryA);
    expect(adapter._callSidForServer).toBe(aSid);

    // 2. Expire A; its hang-up blocks in flight.
    expiryA.release();
    await vi.waitUntil(() => rest.endCalls.includes(aSid), { timeout: 1_000 });

    // 3. Call B takes over (bumps the timer generation); connect B's socket.
    const expiryB = controlledExpiry();
    installExpiry(adapter, expiryB);
    const callB = adapter.placeCall({
      to: A_LEG_DESTINATION,
      attachStream: "a-leg",
      timeoutMs: 120_000,
      maxCallDurationSeconds: 42,
    });
    await vi.waitUntil(() => rest.placeCallArgs.length === 2, { timeout: 1_000 });
    await armed(expiryB);
    expect(adapter._callSidForServer).toBe(bSid);
    const nonceB = NONCE_RE.exec(rest.placeCallArgs[1].twiml)![1];
    const genuineB = scriptedSocket([startFrame({ nonce: nonceB, callSid: bSid })]);
    await drive(adapter, genuineB, { production: true });
    await callB;
    expect(adapter._streamWsForServer).toBe(genuineB);

    // 4. Release A's held hang-up. Its handler resumes, sees a newer generation,
    //    and must leave B's socket alone.
    releaseEnd();
    await flush();
    expect(genuineB.closed, "A's expired watchdog closed B's socket").toBe(false);
    expect(adapter._streamWsForServer).toBe(genuineB);
    expect(rest.endCalls, "only the expired call was ended").toEqual([aSid]);

    // B's own watchdog is still live and targets B, not A.
    expiryB.release();
    await vi.waitFor(() => expect(rest.endCalls).toEqual([aSid, bSid]));
  });

  it("#762 P2 follow-up: a b-leg takeover A never sees closes B's socket (guard keyed on the re-arm counter)", async () => {
    // The a-leg case above was caught because a re-arming a-leg B bumps
    // `_maxDurationGeneration`. A plain b-leg (also `waitForCall`, or a no-cap
    // dial) arms no timer, so it bumps ONLY `_callGeneration` — invisible to a
    // guard keyed on the re-arm counter. Mirror the Python P2 test's choice and
    // let B be a plain b-leg `placeCall({ to })`.
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;

    const aSid = "CA" + "a".repeat(32);
    const bSid = "CB" + "b".repeat(32);
    const sids = [aSid, bSid];
    let placeIdx = 0;
    rest.placeCall = async (args) => {
      rest.placeCallArgs.push(args);
      return sids[placeIdx++];
    };
    let releaseEnd!: () => void;
    const endHeld = new Promise<void>((resolve) => (releaseEnd = resolve));
    rest.endCall = async (callSid: string) => {
      rest.endCalls.push(callSid);
      if (callSid === aSid) await endHeld;
    };

    // 1. Place a-leg A and connect its socket; arm its watchdog.
    const expiryA = controlledExpiry();
    installExpiry(adapter, expiryA);
    const callA = adapter.placeCall({
      to: A_LEG_DESTINATION,
      attachStream: "a-leg",
      timeoutMs: 120_000,
      maxCallDurationSeconds: 42,
    });
    await vi.waitUntil(() => rest.placeCallArgs.length === 1, { timeout: 1_000 });
    const nonceA = NONCE_RE.exec(rest.placeCallArgs[0].twiml)![1];
    await drive(adapter, scriptedSocket([startFrame({ nonce: nonceA, callSid: aSid })]), {
      production: true,
    });
    await callA;
    await armed(expiryA);

    // 2. Expire A; its hang-up blocks in flight.
    expiryA.release();
    await vi.waitUntil(() => rest.endCalls.includes(aSid), { timeout: 1_000 });

    // 3. A PLAIN B-LEG B takes over — bumps `_callGeneration` only, never the
    //    re-arm counter. Connect B's un-gated (nonce-less) socket.
    const callB = adapter.placeCall({ to: A_LEG_DESTINATION }); // default b-leg
    await vi.waitUntil(() => rest.placeCallArgs.length === 2, { timeout: 1_000 });
    const genuineB = scriptedSocket([startFrame({ callSid: bSid })]);
    await drive(adapter, genuineB, { production: true });
    await callB;
    expect(adapter._streamWsForServer).toBe(genuineB);

    // 4. Release A's held hang-up. A sees a newer call generation and must leave
    //    both B's socket and B's ended-reason alone; only A's own SID is ended.
    releaseEnd();
    await flush();
    expect(genuineB.closed, "A's expired watchdog closed the b-leg's socket").toBe(false);
    expect(adapter._streamWsForServer).toBe(genuineB);
    expect(endedReason(adapter), "A's watchdog mislabelled the b-leg call").not.toBe(
      "max_duration",
    );
    expect(rest.endCalls, "only the expired call was ended").toEqual([aSid]);
  });

  it("#762 P2 follow-up: a stale watchdog firing AFTER a takeover never relabels the newer call", async () => {
    // Independent of the socket close: `"max_duration"` wins ended-reason ties
    // permanently, so a watchdog that fires once a newer call is already live
    // would brand that call for the rest of its life. B takes over FIRST, then
    // A's stale watchdog fires — its own SID is still hung up (call A really did
    // exceed its cap) but B's ended-reason must be untouched.
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;

    const aSid = "CA" + "a".repeat(32);
    const bSid = "CB" + "b".repeat(32);
    const sids = [aSid, bSid];
    let placeIdx = 0;
    rest.placeCall = async (args) => {
      rest.placeCallArgs.push(args);
      return sids[placeIdx++];
    };

    // 1. Place a-leg A, connect its socket, arm its watchdog — hold expiry.
    const expiryA = controlledExpiry();
    installExpiry(adapter, expiryA);
    const callA = adapter.placeCall({
      to: A_LEG_DESTINATION,
      attachStream: "a-leg",
      timeoutMs: 120_000,
      maxCallDurationSeconds: 42,
    });
    await vi.waitUntil(() => rest.placeCallArgs.length === 1, { timeout: 1_000 });
    const nonceA = NONCE_RE.exec(rest.placeCallArgs[0].twiml)![1];
    await drive(adapter, scriptedSocket([startFrame({ nonce: nonceA, callSid: aSid })]), {
      production: true,
    });
    await callA;
    await armed(expiryA);

    // 2. A plain b-leg B takes over and goes live BEFORE A's watchdog fires.
    const callB = adapter.placeCall({ to: A_LEG_DESTINATION }); // default b-leg
    await vi.waitUntil(() => rest.placeCallArgs.length === 2, { timeout: 1_000 });
    const genuineB = scriptedSocket([startFrame({ callSid: bSid })]);
    await drive(adapter, genuineB, { production: true });
    await callB;
    expect(endedReason(adapter)).toBe("none");

    // 3. NOW A's stale watchdog fires. It ends its own SID (correct) but must
    //    not stamp `max_duration` on B's live call.
    expiryA.release();
    await vi.waitUntil(() => rest.endCalls.includes(aSid), { timeout: 1_000 });
    await flush();
    expect(endedReason(adapter), "a stale watchdog relabelled a call it does not own").not.toBe(
      "max_duration",
    );
    expect(genuineB.closed).toBe(false);
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
      to: A_LEG_DESTINATION,
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
