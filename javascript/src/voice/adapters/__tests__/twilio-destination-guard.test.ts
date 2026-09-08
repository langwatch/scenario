/**
 * A-leg destination allowlist + tunnel readiness (scenario#762 Slice 4,
 * guardrail (c)).
 *
 * `allowedCallers` gates who may dial IN. A-leg mode dials OUT to numbers this
 * Twilio account does not own, so an unguarded `to` is an unbounded dialer:
 * destinations are deny-by-default via `allowedCallees`. The same
 * pre-origination slot also probes that our public URL is live at the edge —
 * otherwise Twilio dials out, opens the media socket against a dead tunnel, and
 * the caller pays for a call that ends in a confusing stream-connect timeout.
 *
 * Binds AC8 (allowlist) and AC9 (tunnel readiness) of
 * `specs/voice-twilio-a-leg-external.feature`. Mirrors
 * `python/tests/voice/test_twilio_destination_guard.py`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { TwilioAgentAdapter } from "../twilio";
import { TunnelNotReadyError, TwilioRESTHelper } from "../twilio-shared";

/** The one number the a-leg tests are allowed to dial. */
const ALLOWED = "+447911123456";

type SpyRest = TwilioRESTHelper & {
  /** Every callee-touching REST call in order, so tests can assert its absence. */
  restCallLog: Array<[string, unknown[]]>;
  placeCallArgs: Array<{ to: string; from: string; twiml: string }>;
};

function spyRest(): SpyRest {
  const stub = new TwilioRESTHelper("ACtest", "secret") as SpyRest;
  stub.restCallLog = [];
  stub.placeCallArgs = [];
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
  stub.placeCall = async (a: { to: string; from: string; twiml: string }) => {
    stub.placeCallArgs.push(a);
    return "CA" + "1".repeat(32);
  };
  stub.sendDtmfOnCall = async () => undefined;
  return stub;
}

/**
 * Readiness probe double, recording WHEN it was consulted.
 *
 * `originationsAtProbe` is the number of `Calls.create` calls already issued
 * when the probe ran — the assertion that readiness is checked *before*
 * origination, not merely somewhere inside `placeCall`. Never touches the
 * network; the real edge probe is exercised only by the env-gated live smoke.
 */
class FakeTunnel {
  calls = 0;
  originationsAtProbe: number | null = null;

  constructor(
    private readonly rest: SpyRest,
    private readonly error?: Error,
  ) {}

  async waitUntilEdgeReachable(): Promise<void> {
    this.calls += 1;
    this.originationsAtProbe = this.rest.placeCallArgs.length;
    if (this.error) throw this.error;
  }
}

function makeAdapter(
  rest: SpyRest,
  opts: { allowedCallees?: readonly string[]; tunnel?: FakeTunnel },
): TwilioAgentAdapter {
  return new TwilioAgentAdapter({
    accountSid: "ACtest",
    authToken: "secret",
    phoneNumber: "+14155551234",
    publicBaseUrl: "https://example.test",
    validateSignature: false,
    allowedCallees: opts.allowedCallees,
    tunnelReadiness: opts.tunnel,
    rest,
  });
}

describe("TwilioAgentAdapter a-leg destination guard", () => {
  let openAdapter: TwilioAgentAdapter | null = null;
  let baseLog = 0;

  afterEach(async () => {
    if (openAdapter) {
      await openAdapter.disconnect();
      openAdapter = null;
    }
  });

  /** Connected adapter with the probe wired in and connect()'s REST sliced off. */
  async function connected(opts: {
    allowedCallees?: readonly string[];
    tunnelError?: Error;
  }): Promise<{ adapter: TwilioAgentAdapter; rest: SpyRest; tunnel: FakeTunnel }> {
    const rest = spyRest();
    const tunnel = new FakeTunnel(rest, opts.tunnelError);
    const adapter = makeAdapter(rest, {
      allowedCallees: opts.allowedCallees,
      tunnel,
    });
    await adapter.connect();
    openAdapter = adapter;
    baseLog = rest.restCallLog.length;
    // placeCall waits for the media stream; nothing drives a socket here.
    adapter._signalStreamConnected();
    return { adapter, rest, tunnel };
  }

  /** No origination, no other REST traffic, no nonce minted. */
  function expectNothingDialed(adapter: TwilioAgentAdapter, rest: SpyRest): void {
    expect(rest.placeCallArgs, "a refused destination still originated a call").toEqual(
      [],
    );
    expect(
      rest.restCallLog.slice(baseLog),
      "a refused destination still hit Twilio REST",
    ).toEqual([]);
    expect(
      adapter._streamNonceForServer,
      "a refused destination still minted a nonce",
    ).toBeUndefined();
  }

  // -------------------------------------------------------------------- AC8

  it("AC8: a-leg refuses before origination when allowedCallees is unset", async () => {
    const { adapter, rest } = await connected({});
    await expect(
      adapter.placeCall({ to: ALLOWED, attachStream: "a-leg" }),
    ).rejects.toThrow(/requires allowedCallees/);
    expectNothingDialed(adapter, rest);
  });

  it("AC8: a-leg refuses a destination absent from allowedCallees", async () => {
    const { adapter, rest } = await connected({ allowedCallees: [ALLOWED] });
    await expect(
      adapter.placeCall({ to: "+14155557777", attachStream: "a-leg" }),
    ).rejects.toThrow(/not in allowedCallees/);
    expectNothingDialed(adapter, rest);
  });

  it("AC8 (positive): the allowlisted destination originates normally", async () => {
    const { adapter, rest } = await connected({ allowedCallees: [ALLOWED] });
    await adapter.placeCall({ to: ALLOWED, attachStream: "a-leg" });
    expect(rest.placeCallArgs).toHaveLength(1);
    expect(rest.placeCallArgs[0].to).toBe(ALLOWED);
  });

  it.each([
    ["to-is-prefix", [ALLOWED], "+4479111234"],
    ["to-is-suffix", [ALLOWED], "+7911123456"],
    ["entry-is-prefix", ["+4479111234"], ALLOWED],
  ])(
    "refuses a near-miss destination (%s) — substring is not membership",
    async (_id, allowedCallees, to) => {
      const { adapter, rest } = await connected({
        allowedCallees: allowedCallees as string[],
      });
      await expect(
        adapter.placeCall({ to: to as string, attachStream: "a-leg" }),
      ).rejects.toThrow(/not in allowedCallees/);
      expectNothingDialed(adapter, rest);
    },
  );

  it("rejects a non-E.164 allowedCallees entry at construction", () => {
    expect(() =>
      makeAdapter(spyRest(), { allowedCallees: ["447911123456"] }),
    ).toThrow(/E\.164/);
  });

  it("b-leg is unaffected by an unset allowedCallees", async () => {
    // b-leg can only reach numbers this account owns, which is its own
    // guardrail — it is never gated on allowedCallees.
    const { adapter, rest } = await connected({});
    await adapter.placeCall({ to: "+14155557777" }); // default b-leg
    expect(rest.placeCallArgs).toHaveLength(1);
    expect(rest.placeCallArgs[0].to).toBe("+14155557777");
  });

  // -------------------------------------------------------------------- AC9

  it("AC9: an unreachable tunnel throws TunnelNotReadyError before origination", async () => {
    const { adapter, rest, tunnel } = await connected({
      allowedCallees: [ALLOWED],
      tunnelError: new Error("edge did not resolve"),
    });
    await expect(
      adapter.placeCall({ to: ALLOWED, attachStream: "a-leg" }),
    ).rejects.toThrow(TunnelNotReadyError);
    expect(tunnel.calls).toBe(1);
    expectNothingDialed(adapter, rest);
  });

  it("AC9 (ordering): the probe runs while zero calls have been originated", async () => {
    const { adapter, rest, tunnel } = await connected({ allowedCallees: [ALLOWED] });
    await adapter.placeCall({ to: ALLOWED, attachStream: "a-leg" });
    expect(tunnel.calls).toBe(1);
    expect(tunnel.originationsAtProbe).toBe(0);
    expect(rest.placeCallArgs).toHaveLength(1);
  });

  it("checks the free local allowlist before consulting the tunnel", async () => {
    const { adapter, rest, tunnel } = await connected({
      allowedCallees: [ALLOWED],
      tunnelError: new Error("edge did not resolve"),
    });
    await expect(
      adapter.placeCall({ to: "+14155557777", attachStream: "a-leg" }),
    ).rejects.toThrow(/not in allowedCallees/);
    expect(tunnel.calls).toBe(0);
    expectNothingDialed(adapter, rest);
  });

  it("b-leg does not probe the tunnel", async () => {
    // b-leg's stream arrives via the callee's rewritten webhook, and b-leg has
    // always run without a readiness probe — the probe stays a-leg-only.
    const { adapter, rest, tunnel } = await connected({
      allowedCallees: [ALLOWED],
      tunnelError: new Error("edge did not resolve"),
    });
    await adapter.placeCall({ to: "+14155557777" }); // default b-leg
    expect(tunnel.calls).toBe(0);
    expect(rest.placeCallArgs).toHaveLength(1);
  });
});
