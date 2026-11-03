/**
 * `expectStream` — arms the a-leg media-stream nonce/callSid gate
 * (scenario#762 guardrail (a), `twilio-server.ts`'s `authenticate`) WITHOUT
 * placing an outbound call (tasks#1002 slice 3, worker-side dial).
 *
 * Mirrors `twilio-stream-auth.test.ts`'s per-frame-gate coverage, but arms
 * via `expectStream({ nonce, callSid })` instead of an a-leg `placeCall`: the
 * pod that owns the media-stream socket is not the pod that dialed, so it has
 * no call to place. The security guarantee must be identical either way — no
 * dial does not mean no verification.
 */

import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it } from "vitest";

import type { TwilioAgentAdapter } from "../twilio";
import { drive, makeAdapter, scriptedSocket, spyRest, startFrame } from "./a-leg-harness";

const EXPECTED_NONCE = "a".repeat(32);
const EXPECTED_CALL_SID = "CA" + "7".repeat(32);

describe("TwilioAgentAdapter.expectStream", () => {
  let openAdapter: TwilioAgentAdapter | null = null;

  afterEach(async () => {
    if (openAdapter) {
      await openAdapter.disconnect();
      openAdapter = null;
    }
  });

  it("arms the gate: _streamNonceForServer / _callSidForServer reflect the args", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;

    expect(adapter._streamNonceForServer).toBeUndefined();
    adapter.expectStream({ nonce: EXPECTED_NONCE, callSid: EXPECTED_CALL_SID });
    expect(adapter._streamNonceForServer).toBe(EXPECTED_NONCE);
    expect(adapter._callSidForServer).toBe(EXPECTED_CALL_SID);
  });

  it("a start frame with the matching nonce and callSid is accepted", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    adapter.expectStream({ nonce: EXPECTED_NONCE, callSid: EXPECTED_CALL_SID });

    const ws = scriptedSocket([
      startFrame({ nonce: EXPECTED_NONCE, callSid: EXPECTED_CALL_SID }),
    ]);
    await drive(adapter, ws);
    expect(ws.closed).toBe(false);
    expect(adapter._streamWsForServer).toBe(ws);
    expect(adapter._streamSidForTest).toBe("MZ762");
  });

  it("a start frame with a mismatched nonce is rejected, exactly like placeCall's gate", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    adapter.expectStream({ nonce: EXPECTED_NONCE, callSid: EXPECTED_CALL_SID });

    const attacker = scriptedSocket([
      startFrame({ nonce: "not-the-nonce", callSid: EXPECTED_CALL_SID }),
    ]);
    await drive(adapter, attacker);
    expect(attacker.closed).toBe(true);
    expect(adapter._streamWsForServer).toBeNull();
  });

  it("a start frame with no nonce Parameter at all is rejected, not a bypass", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    adapter.expectStream({ nonce: EXPECTED_NONCE, callSid: EXPECTED_CALL_SID });

    const attacker = scriptedSocket([startFrame({ callSid: EXPECTED_CALL_SID })]);
    await drive(adapter, attacker);
    expect(attacker.closed).toBe(true);
    expect(adapter._streamWsForServer).toBeNull();
  });

  it("a start frame with the right nonce but the wrong callSid is ignored, not adopted", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    adapter.expectStream({ nonce: EXPECTED_NONCE, callSid: EXPECTED_CALL_SID });

    const stale = scriptedSocket([
      startFrame({ nonce: EXPECTED_NONCE, callSid: "CAsomeoneelse" }),
    ]);
    await drive(adapter, stale);
    expect(stale.closed).toBe(false); // ignored, not closed outright (AC6 shape)
    expect(adapter._streamWsForServer).toBeNull();

    const genuine = scriptedSocket([
      startFrame({ nonce: EXPECTED_NONCE, callSid: EXPECTED_CALL_SID }),
    ]);
    await drive(adapter, genuine);
    expect(adapter._streamWsForServer).toBe(genuine);
  });

  it("evicts a socket already adopted before expectStream armed the gate (CWE-306 arming race)", async () => {
    // Mirrors `twilio-stream-auth.test.ts`'s "#762 P1: a socket adopted before
    // dialing is evicted" case, with `expectStream` doing the arming instead of
    // `placeCall`. A custom socket (not `scriptedSocket`) because the test needs
    // to pause mid-frame-list to arm the gate between the socket's adoption and
    // its next frame.
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;

    const stopFrame = JSON.stringify({ event: "stop" });
    const frames = [startFrame({}), stopFrame];
    let idx = 0;
    let releaseStop!: () => void;
    const released = new Promise<void>((resolve) => (releaseStop = resolve));
    let signalStartSeen!: () => void;
    const startSeen = new Promise<void>((resolve) => (signalStartSeen = resolve));
    const early = {
      closed: false,
      sent: [] as string[],
      send(data: string | Uint8Array) {
        this.sent.push(
          typeof data === "string" ? data : Buffer.from(data).toString("utf-8"),
        );
      },
      async receiveText(): Promise<string | null> {
        // Hold the stop frame until the test releases it, after arming.
        if (idx === 1) {
          signalStartSeen();
          await released;
        }
        if (idx < frames.length) return frames[idx++];
        return new Promise<string | null>(() => {
          /* park: socket stays open */
        });
      },
      close() {
        this.closed = true;
      },
    };

    // 1. The early un-nonced socket adopts un-gated (nothing armed yet).
    const earlyLoop = adapter._driveMediaStream(early);
    await startSeen;
    expect(adapter._streamWsForServer).toBe(early);

    // 2. expectStream arms the gate and bumps the call generation.
    adapter.expectStream({ nonce: EXPECTED_NONCE, callSid: EXPECTED_CALL_SID });
    expect(adapter._streamWsForServer, "the stale socket stayed our transport").toBeNull();

    // 3. Release the stale socket's stop frame: the generation guard closes it.
    releaseStop();
    await earlyLoop;
    expect(early.closed).toBe(true);

    // 4. The genuine nonce+callSid socket is the one that adopts.
    const genuine = scriptedSocket([
      startFrame({ nonce: EXPECTED_NONCE, callSid: EXPECTED_CALL_SID }),
    ]);
    await drive(adapter, genuine);
    expect(adapter._streamWsForServer).toBe(genuine);
  });

  it("media from a socket that never authenticated against the armed gate is dropped", async () => {
    const rest = spyRest();
    const adapter = makeAdapter(rest);
    await adapter.connect();
    openAdapter = adapter;
    adapter.expectStream({ nonce: EXPECTED_NONCE, callSid: EXPECTED_CALL_SID });

    const media = JSON.stringify({
      event: "media",
      streamSid: "MZ762",
      media: { payload: Buffer.from(new Uint8Array(160).fill(0xff)).toString("base64") },
    });
    const attacker = scriptedSocket([media]);
    await drive(adapter, attacker);
    expect(adapter._framesReceivedForTest).toBe(0);
    expect(adapter._streamWsForServer).toBeNull();
  });
});
