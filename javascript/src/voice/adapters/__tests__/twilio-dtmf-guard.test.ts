/**
 * `sendDtmf` is refused in a-leg mode (scenario#762 Slice 5, AC10).
 *
 * `sendDtmf` works by `calls(sid).update({ twiml })`, which REPLACES the TwiML
 * the live call is executing. Under b-leg the replaced TwiML is a hold on our
 * own leg and the Media Stream rides the callee's leg, so the redirect is
 * harmless. Under a-leg the replaced TwiML IS the `<Connect><Stream>` carrying
 * the scenario, so the same REST call would tear down the media session mid-run.
 *
 * Binds AC10 of `specs/voice-twilio-a-leg-external.feature`. Mirrors
 * `python/tests/voice/test_twilio_dtmf_guard.py`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { A_LEG_SEND_DTMF_UNSUPPORTED, TwilioAgentAdapter } from "../twilio";
import {
  drive,
  makeAdapter,
  scriptedSocket,
  spyRest,
  startALegCall,
  startFrame,
} from "./a-leg-harness";

describe("TwilioAgentAdapter sendDtmf a-leg guard", () => {
  let openAdapter: TwilioAgentAdapter | null = null;

  afterEach(async () => {
    if (openAdapter) {
      await openAdapter.disconnect();
      openAdapter = null;
    }
  });

  it("AC10: a-leg sendDtmf throws, writes no TwiML-replace POST, and leaves the stream alone", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    const { nonce, call } = await startALegCall(adapter, rest);

    const ws = scriptedSocket([startFrame({ nonce })]);
    await drive(adapter, ws);
    await call;
    expect(adapter._streamWsForTest, "precondition: the a-leg socket is live").toBe(ws);

    await expect(adapter.sendDtmf("123")).rejects.toThrow(A_LEG_SEND_DTMF_UNSUPPORTED);
    // The refusal must say WHY, not merely that it is unsupported.
    expect(A_LEG_SEND_DTMF_UNSUPPORTED).toContain("<Connect><Stream>");
    expect(rest.dtmfCalls).toEqual([]);
    expect(ws.closed).toBe(false);
    expect(adapter._streamWsForTest).toBe(ws);
  });

  it("b-leg sendDtmf still reaches the REST helper unchanged", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    const call = adapter.placeCall({ to: "+14155557777" }); // default b-leg
    await vi.waitUntil(() => rest.placeCallArgs.length > 0, { timeout: 1_000 });
    adapter._signalStreamConnected();
    await call;
    expect(adapter._streamNonceForServer).toBeUndefined();

    await adapter.sendDtmf("123");

    expect(rest.dtmfCalls).toEqual([[adapter._callSidForServer, "123"]]);
  });
});
