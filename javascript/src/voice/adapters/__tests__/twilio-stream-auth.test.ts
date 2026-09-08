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

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TwilioAgentAdapter } from "../twilio";
import { STREAM_NONCE_HEX_LEN } from "../twilio-shared";
// One shared a-leg socket double + REST spy across the nonce, DTMF-guard and
// frame-loop suites — see `a-leg-harness.ts`.
import {
  drive,
  isPending,
  makeAdapter,
  NONCE_RE,
  ORIGINATED_CALL_SID,
  scriptedSocket,
  spyRest,
  startALegCall,
  startFrame,
} from "./a-leg-harness";

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
