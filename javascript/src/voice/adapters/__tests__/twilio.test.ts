/**
 * TwilioAgentAdapter protocol unit tests — binds the three @integration
 * @ts-bound scenarios tagged @ts-twilio-proto in `specs/voice-agents.feature`.
 *
 * Uses an in-process mock WebSocket so the assertions hit only the adapter's
 * frame parser, capability declaration, and interrupt path — no real HTTP/WS
 * server, no real Twilio.
 */

import { Buffer } from "node:buffer";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VOICE_AGENTS_FEATURE } from "../../../__tests__/features";
import { AudioChunk } from "../../audio-chunk";
import { TwilioAgentAdapter } from "../twilio";
import type { MediaStreamWebSocket } from "../twilio-server";
import {
  TwilioRESTHelper,
  buildMediaFrame,
  mulaw8kToPcm16_24k,
  parseMediaStreamFrame,
  pcm16_24kToMulaw8k,
  validateDtmf,
  validateE164,
  verifyTwilioSignature,
} from "../twilio-shared";

const feature = await loadFeature(VOICE_AGENTS_FEATURE);

/** Build an adapter wired to a stubbed REST helper so connect() can run. */
function makeAdapter(opts?: {
  publicBaseUrl?: string;
  validateSignature?: boolean;
  onDtmf?: (digit: string) => void;
}): TwilioAgentAdapter {
  const rest = stubRest("PN1234567890abcdef");
  return new TwilioAgentAdapter({
    accountSid: "ACtest",
    authToken: "secret",
    phoneNumber: "+14155551234",
    publicBaseUrl: opts?.publicBaseUrl ?? "https://example.test",
    validateSignature: opts?.validateSignature ?? false,
    onDtmf: opts?.onDtmf,
    rest,
  });
}

/** Stub of TwilioRESTHelper — every method is a no-op or returns the SID. */
function stubRest(sid: string): TwilioRESTHelper {
  const stub = new TwilioRESTHelper("ACtest", "secret");
  // Replace network methods with deterministic stubs.
  stub.resolvePhoneNumberSid = async () => sid;
  stub.readVoiceUrl = async () => null;
  stub.writeVoiceUrl = async () => undefined;
  stub.placeCall = async () => "CAtest";
  stub.sendDtmfOnCall = async () => undefined;
  return stub;
}

/**
 * Recording stand-in for TwilioRESTHelper. `restCallLog` captures every
 * callee-touching call in order (so tests can assert an exact b-leg sequence or
 * its a-leg absence); `resolveError`, when set, makes resolve throw.
 */
type SpyRest = TwilioRESTHelper & {
  restCallLog: Array<[string, unknown[]]>;
  writeCalls: Array<[string, string]>;
  placeCallArgs: Array<{
    to: string;
    from: string;
    twiml: string;
    timeLimitSeconds?: number;
  }>;
  resolveError: Error | null;
  priorVoiceUrl: string;
};

function spyRest(sid: string): SpyRest {
  const stub = new TwilioRESTHelper("ACtest", "secret") as SpyRest;
  stub.restCallLog = [];
  stub.writeCalls = [];
  stub.placeCallArgs = [];
  stub.resolveError = null;
  stub.priorVoiceUrl = "https://old-webhook.example.com/previous";
  stub.resolvePhoneNumberSid = async (number: string) => {
    stub.restCallLog.push(["resolvePhoneNumberSid", [number]]);
    if (stub.resolveError) throw stub.resolveError;
    return sid;
  };
  stub.readVoiceUrl = async (s: string) => {
    stub.restCallLog.push(["readVoiceUrl", [s]]);
    return stub.priorVoiceUrl;
  };
  stub.writeVoiceUrl = async (s: string, url: string) => {
    stub.writeCalls.push([s, url]);
    stub.restCallLog.push(["writeVoiceUrl", [s, url]]);
  };
  stub.placeCall = async (a: {
    to: string;
    from: string;
    twiml: string;
    timeLimitSeconds?: number;
  }) => {
    stub.placeCallArgs.push(a);
    return "CAtest";
  };
  stub.sendDtmfOnCall = async () => undefined;
  return stub;
}

/** Read a private field off the adapter for state assertions. */
function calleeState(adapter: TwilioAgentAdapter): {
  sid?: string;
  prior?: string;
} {
  const a = adapter as unknown as {
    _calleePhoneNumberSid?: string;
    _priorCalleeVoiceUrl?: string;
  };
  return { sid: a._calleePhoneNumberSid, prior: a._priorCalleeVoiceUrl };
}

/** Lightweight mock WS that captures send() output and feeds receiveText(). */
function mockSocket(): MediaStreamWebSocket & { sent: string[]; emit(text: string): void; closeNow(): void } {
  const sent: string[] = [];
  const incoming: string[] = [];
  let closed = false;
  let resolver: ((text: string | null) => void) | null = null;

  return {
    sent,
    send(data) {
      sent.push(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
    },
    receiveText() {
      const head = incoming.shift();
      if (head !== undefined) return Promise.resolve(head);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        resolver = resolve;
      });
    },
    close() {
      this.closeNow();
    },
    emit(text) {
      if (resolver) {
        const r = resolver;
        resolver = null;
        r(text);
        return;
      }
      incoming.push(text);
    },
    closeNow() {
      closed = true;
      if (resolver) {
        const r = resolver;
        resolver = null;
        r(null);
      }
    },
  };
}

describeFeature(
  feature,
  ({ Scenario }) => {
    Scenario(
      "TwilioAgentAdapter publishes mulaw/8000 capabilities and clear-buffer interruption",
      ({ Given, Then, And }) => {
        let adapter: TwilioAgentAdapter;

        Given(
          "a TwilioAgentAdapter constructed with valid credentials and an E.164 phone_number",
          () => {
            adapter = makeAdapter();
          },
        );

        Then(
          'capabilities.inputFormats and outputFormats both equal ["mulaw/8000"]',
          () => {
            expect(adapter.capabilities.inputFormats).toEqual(["mulaw/8000"]);
            expect(adapter.capabilities.outputFormats).toEqual(["mulaw/8000"]);
          },
        );

        And("capabilities.interruption is true (Twilio clear-buffer event)", () => {
          expect(adapter.capabilities.interruption).toBe(true);
        });

        And("capabilities.dtmf is true", () => {
          expect(adapter.capabilities.dtmf).toBe(true);
        });
      },
    );

    Scenario(
      "Twilio Media Streams JSON protocol parses start, media, and stop events",
      ({ Given, When, Then, And }) => {
        const startFrame = JSON.stringify({
          event: "start",
          start: { streamSid: "MZxxx", callSid: "CAxxx" },
        });
        const mulawPayload = new Uint8Array([0xff, 0x7f, 0x00, 0x80]);
        const mediaFrame = buildMediaFrame("MZxxx", mulawPayload);
        const stopFrame = JSON.stringify({ event: "stop", streamSid: "MZxxx" });

        let parsedStart: ReturnType<typeof parseMediaStreamFrame>;
        let parsedMedia: ReturnType<typeof parseMediaStreamFrame>;
        let parsedStop: ReturnType<typeof parseMediaStreamFrame>;

        Given(
          'a stream of Twilio Media Streams JSON frames containing "start", "media", and "stop"',
          () => {
            expect(startFrame).toContain('"start"');
            expect(mediaFrame).toContain('"media"');
            expect(stopFrame).toContain('"stop"');
          },
        );

        When("parseMediaStreamFrame is invoked on each frame", () => {
          parsedStart = parseMediaStreamFrame(startFrame);
          parsedMedia = parseMediaStreamFrame(mediaFrame);
          parsedStop = parseMediaStreamFrame(stopFrame);
        });

        Then("the start frame yields streamSid and callSid", () => {
          expect(parsedStart).not.toBeNull();
          expect(parsedStart!.event).toBe("start");
          expect(parsedStart!.streamSid).toBe("MZxxx");
          expect(parsedStart!.callSid).toBe("CAxxx");
        });

        And("the media frame yields decoded mulaw payload bytes", () => {
          expect(parsedMedia).not.toBeNull();
          expect(parsedMedia!.event).toBe("media");
          expect(parsedMedia!.payloadMulaw).toBeInstanceOf(Uint8Array);
          expect(Array.from(parsedMedia!.payloadMulaw!)).toEqual(Array.from(mulawPayload));
        });

        And("the stop frame yields an event with no payload", () => {
          expect(parsedStop).not.toBeNull();
          expect(parsedStop!.event).toBe("stop");
          expect(parsedStop!.payloadMulaw).toBeUndefined();
        });
      },
    );

    Scenario(
      "Twilio interrupt() sends a clear-buffer frame on the live stream",
      ({ Given, When, Then }) => {
        let adapter: TwilioAgentAdapter;
        let socket: ReturnType<typeof mockSocket>;
        let loop: Promise<void>;

        Given(
          "a TwilioAgentAdapter with a live media stream and a known streamSid",
          async () => {
            adapter = makeAdapter();
            await adapter.connect();
            socket = mockSocket();
            loop = adapter._driveMediaStream(socket);
            socket.emit(
              JSON.stringify({
                event: "start",
                start: { streamSid: "MZinterrupt", callSid: "CAinterrupt" },
              }),
            );
            // Let the loop process the start frame.
            await waitUntil(() => socket.sent.length === 0 && adapter.localBaseUrl !== "");
          },
        );

        When("interrupt() is awaited", async () => {
          await adapter.interrupt();
        });

        Then(
          'a JSON frame with event "clear" and the streamSid is written to the WebSocket',
          async () => {
            expect(socket.sent.length).toBeGreaterThanOrEqual(1);
            const frame = JSON.parse(socket.sent.at(-1)!);
            expect(frame.event).toBe("clear");
            expect(frame.streamSid).toBe("MZinterrupt");
            socket.closeNow();
            await loop;
            await adapter.disconnect();
          },
        );
      },
    );
  },
  { includeTags: [["integration", "ts-twilio-proto"]] },
);

async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: timed out");
    }
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

// ----------------------------------------------------------------------------
// Wire-level coverage for hot paths the cucumber scenarios above don't reach.
// Plain `it()` blocks because the corresponding behaviors aren't @ts-bound
// scenarios — they're internal contracts the adapter must hold.
// ----------------------------------------------------------------------------

describe("twilio-shared codec round-trip", () => {
  it("pcm16/24k → mulaw/8k → pcm16/24k preserves a sine wave within tolerance", () => {
    // 100 ms of 440 Hz tone at 24 kHz.
    const samples = 2400;
    const original = new Uint8Array(samples * 2);
    const view = new DataView(original.buffer);
    for (let i = 0; i < samples; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 20000);
      view.setInt16(i * 2, v, true);
    }
    const mulaw = pcm16_24kToMulaw8k(original);
    expect(mulaw.length).toBeGreaterThan(0);
    expect(mulaw.length).toBe(samples / 3); // 24 kHz → 8 kHz = 3:1 decimation

    const restored = mulaw8kToPcm16_24k(mulaw);
    expect(restored.length).toBeGreaterThan(0);
    // Lossy round-trip — the average sample diff must stay small for a clean
    // tone. Threshold picked empirically; G.711 µ-law adds modest quantization
    // noise but doesn't shred the waveform.
    const restoredView = new DataView(restored.buffer);
    let totalAbsDiff = 0;
    const compareSamples = Math.min(samples, restored.length / 2);
    for (let i = 0; i < compareSamples; i++) {
      const a = view.getInt16(i * 2, true);
      const b = restoredView.getInt16(i * 2, true);
      totalAbsDiff += Math.abs(a - b);
    }
    const avgAbsDiff = totalAbsDiff / compareSamples;
    expect(avgAbsDiff).toBeLessThan(2000); // <10% of peak amplitude (20000)
  });

  it("empty input produces empty output for both directions", () => {
    expect(pcm16_24kToMulaw8k(new Uint8Array(0))).toHaveLength(0);
    expect(mulaw8kToPcm16_24k(new Uint8Array(0))).toHaveLength(0);
  });
});

describe("validateE164 / validateDtmf", () => {
  it("validateE164 accepts canonical numbers and rejects junk", () => {
    expect(() => validateE164("+14155551234")).not.toThrow();
    expect(() => validateE164("+447700900123")).not.toThrow();
    expect(() => validateE164("14155551234")).toThrow(/E.164/); // missing +
    expect(() => validateE164("+0155551234")).toThrow(/E.164/); // leading 0
    expect(() => validateE164("+1234")).toThrow(/E.164/); // too short
    expect(() => validateE164("")).toThrow(/E.164/);
  });

  it("validateDtmf accepts the DTMF charset and rejects everything else", () => {
    expect(() => validateDtmf("123")).not.toThrow();
    expect(() => validateDtmf("*0#")).not.toThrow();
    expect(() => validateDtmf("1wW2")).not.toThrow();
    expect(() => validateDtmf("")).toThrow(/DTMF/);
    expect(() => validateDtmf("12a")).toThrow(/DTMF/);
    // The injection payload the validator's docstring warns about.
    expect(() => validateDtmf('1"/><Say>x</Say><Play digits="')).toThrow(/DTMF/);
  });
});

describe("verifyTwilioSignature", () => {
  // Twilio signs HMAC-SHA1(authToken, url + sortedParamsConcat) and base64s
  // the digest. Build a known-good signature manually and verify both branches.
  async function signFixture(args: {
    authToken: string;
    url: string;
    params: Record<string, string>;
  }): Promise<string> {
    const { createHmac } = await import("node:crypto");
    const sortedKeys = Object.keys(args.params).sort();
    let data = args.url;
    for (const key of sortedKeys) data += key + args.params[key];
    return createHmac("sha1", args.authToken).update(data).digest("base64");
  }

  it("accepts a signature computed against the same inputs", async () => {
    const authToken = "test-token-xyz";
    const url = "https://example.test/twilio/voice";
    const params = { From: "+14155557777", CallSid: "CA1" };
    const signature = await signFixture({ authToken, url, params });
    expect(await verifyTwilioSignature({ authToken, url, params, signature })).toBe(true);
  });

  it("rejects a signature signed with a different auth token", async () => {
    const url = "https://example.test/twilio/voice";
    const params = { From: "+14155557777" };
    const signature = await signFixture({ authToken: "wrong", url, params });
    expect(
      await verifyTwilioSignature({ authToken: "real", url, params, signature }),
    ).toBe(false);
  });

  it("rejects a signature signed against a different URL", async () => {
    const authToken = "shared";
    const params = { From: "+14155557777" };
    const signature = await signFixture({
      authToken,
      url: "https://attacker.test/twilio/voice",
      params,
    });
    expect(
      await verifyTwilioSignature({
        authToken,
        url: "https://example.test/twilio/voice",
        params,
        signature,
      }),
    ).toBe(false);
  });

  it("rejects when the signature is missing", async () => {
    expect(
      await verifyTwilioSignature({
        authToken: "x",
        url: "https://example.test",
        params: {},
        signature: undefined,
      }),
    ).toBe(false);
  });
});

describe("TwilioAgentAdapter integration paths", () => {
  let openAdapter: TwilioAgentAdapter | null = null;

  afterEach(async () => {
    if (openAdapter) {
      await openAdapter.disconnect();
      openAdapter = null;
    }
  });

  it("fires onDtmf when a DTMF media-stream frame arrives", async () => {
    const onDtmf = vi.fn();
    const adapter = makeAdapter({ onDtmf });
    await adapter.connect();
    openAdapter = adapter;
    const socket = mockSocket();
    const loop = adapter._driveMediaStream(socket);
    socket.emit(
      JSON.stringify({ event: "start", start: { streamSid: "MZdtmf", callSid: "CAdtmf" } }),
    );
    socket.emit(JSON.stringify({ event: "dtmf", streamSid: "MZdtmf", dtmf: { digit: "5" } }));
    await waitUntil(() => onDtmf.mock.calls.length > 0);
    expect(onDtmf).toHaveBeenCalledWith("5");
    socket.closeNow();
    await loop;
  });

  it("rejects POSTs from callers not in allowedCallers and records the rejection", async () => {
    const adapter = new TwilioAgentAdapter({
      accountSid: "ACtest",
      authToken: "secret",
      phoneNumber: "+14155551234",
      publicBaseUrl: "https://example.test",
      validateSignature: false,
      allowedCallers: ["+14155557777"],
      rest: stubRest("PNallow"),
    });
    await adapter.connect();
    openAdapter = adapter;
    expect(adapter.rejectedCount).toBe(0);

    const form = new URLSearchParams({ From: "+14155550000", CallSid: "CAblocked" });
    const response = await fetch(`${adapter.localBaseUrl}/twilio/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("<Reject/>");
    expect(adapter.rejectedCount).toBe(1);
  });

  it("flushes buffered µ-law on a stop frame and exits the loop", async () => {
    const adapter = makeAdapter();
    await adapter.connect();
    openAdapter = adapter;
    const socket = mockSocket();
    const loop = adapter._driveMediaStream(socket);
    socket.emit(
      JSON.stringify({ event: "start", start: { streamSid: "MZstop", callSid: "CAstop" } }),
    );
    // 50 ms of µ-law payload (50 * 8 = 400 bytes) — below the 100 ms flush
    // threshold, so the loop holds it in the buffer until the stop frame.
    const payload = new Uint8Array(400).fill(0xff);
    socket.emit(buildMediaFrame("MZstop", payload));
    socket.emit(JSON.stringify({ event: "stop", streamSid: "MZstop" }));
    await loop; // loop exits when it sees `stop`
    const chunk = await adapter.receiveAudio(0.5);
    expect(chunk).toBeInstanceOf(AudioChunk);
    expect(chunk.data.length).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------------------------
// A-leg external mode (scenario#762 Slice 1): originate <Connect><Stream> on
// our own leg so `to` can be any external number, touching nothing on the
// callee. Mirrors python/tests/voice/test_twilio_adapter.py.
// ----------------------------------------------------------------------------

/** The exact origination TwiML a-leg mode emits, as a template over the per-call
 * nonce (Slice 2). Pinned literally so any further TwiML change is a visible
 * diff. makeAdapter's publicBaseUrl is https://example.test. */
const aLegTwiml = (nonce: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<Response>` +
  `<Connect><Stream url="wss://example.test/twilio/stream">` +
  `<Parameter name="nonce" value="${nonce}"/>` +
  `</Stream></Connect>` +
  `</Response>`;

function makeAdapterWithRest(rest: SpyRest): TwilioAgentAdapter {
  return new TwilioAgentAdapter({
    accountSid: "ACtest",
    authToken: "secret",
    phoneNumber: "+14155551234",
    publicBaseUrl: "https://example.test",
    validateSignature: false,
    // a-leg destinations are deny-by-default (#762 guardrail (c)), so every
    // a-leg test needs the number it dials on the allowlist. The allowlist
    // tests build their own adapters instead.
    allowedCallees: ["+447700900123"],
    rest,
  });
}

describe("TwilioAgentAdapter a-leg external mode", () => {
  let openAdapter: TwilioAgentAdapter | null = null;

  afterEach(async () => {
    if (openAdapter) {
      await openAdapter.disconnect();
      openAdapter = null;
    }
  });

  it("AC1: originates <Connect><Stream> and touches nothing on the callee", async () => {
    const rest = spyRest("PN1234567890abcdef");
    const adapter = makeAdapterWithRest(rest);
    await adapter.connect();
    openAdapter = adapter;
    // connect() resolves the adapter's OWN number; measure callee-zero after it.
    const baseLog = rest.restCallLog.length;
    const baseWrites = rest.writeCalls.length;
    adapter._signalStreamConnected(); // a-leg stream still comes to us
    await adapter.placeCall({ to: "+447700900123", attachStream: "a-leg" });

    expect(rest.placeCallArgs).toHaveLength(1);
    const twiml = rest.placeCallArgs[0].twiml;
    expect(twiml).toContain(`<Connect><Stream url="wss://`);
    expect(twiml).toContain("/twilio/stream");
    // Zero callee REST: no resolve / read / write against the callee.
    expect(rest.restCallLog.slice(baseLog)).toEqual([]);
    expect(rest.writeCalls.slice(baseWrites)).toEqual([]);
  });

  it("pins the exact a-leg TwiML string, nonce <Parameter> included", async () => {
    const rest = spyRest("PN1234567890abcdef");
    const adapter = makeAdapterWithRest(rest);
    await adapter.connect();
    openAdapter = adapter;
    adapter._signalStreamConnected();
    await adapter.placeCall({ to: "+447700900123", attachStream: "a-leg" });
    const nonce = adapter._streamNonceForServer;
    expect(nonce).toBeDefined();
    expect(rest.placeCallArgs[0].twiml).toBe(aLegTwiml(nonce as string));
  });

  it.each([
    ["404-shaped", new Error("HTTP 404: phone number not found")],
    ["500-shaped", new Error("HTTP 500: Twilio internal error")],
  ])(
    "AC3: b-leg resolve error (%s) surfaces with no a-leg fallback",
    async (_id, resolveError) => {
      const rest = spyRest("PN1234567890abcdef");
      const adapter = makeAdapterWithRest(rest);
      await adapter.connect();
      openAdapter = adapter;
      adapter._signalStreamConnected();
      rest.resolveError = resolveError as Error;
      await expect(adapter.placeCall({ to: "+14155557777" })).rejects.toThrow(/HTTP/);
      // No origination — resolve threw before we dialed. If one had occurred,
      // its TwiML must contain no <Connect><Stream>.
      expect(rest.placeCallArgs).toEqual([]);
      for (const a of rest.placeCallArgs) {
        expect(a.twiml).not.toContain("<Connect><Stream>");
      }
    },
  );

  it("AC4 (success): disconnect() after an a-leg call is a no-op with callee state unset", async () => {
    const rest = spyRest("PN1234567890abcdef");
    const adapter = makeAdapterWithRest(rest);
    await adapter.connect();
    const baseWrites = rest.writeCalls.length;
    adapter._signalStreamConnected();
    await adapter.placeCall({ to: "+447700900123", attachStream: "a-leg" });
    expect(calleeState(adapter)).toEqual({ sid: undefined, prior: undefined });
    await adapter.disconnect();
    expect(rest.writeCalls.slice(baseWrites)).toEqual([]);
    expect(calleeState(adapter)).toEqual({ sid: undefined, prior: undefined });
  });

  it("AC4 (failure): disconnect() after an a-leg stream-connect timeout is still a no-op", async () => {
    const rest = spyRest("PN1234567890abcdef");
    const adapter = makeAdapterWithRest(rest);
    await adapter.connect();
    const baseWrites = rest.writeCalls.length;
    // Never signal — a-leg still waits, so this times out.
    await expect(
      adapter.placeCall({ to: "+447700900123", attachStream: "a-leg", timeoutMs: 20 }),
    ).rejects.toThrow();
    expect(calleeState(adapter)).toEqual({ sid: undefined, prior: undefined });
    await adapter.disconnect();
    expect(rest.writeCalls.slice(baseWrites)).toEqual([]);
    expect(calleeState(adapter)).toEqual({ sid: undefined, prior: undefined });
  });

  it.each([
    ["a-leg-vs-true", "a-leg" as const, true],
    ["b-leg-vs-false", "b-leg" as const, false],
    ["a-leg-vs-false", "a-leg" as const, false],
  ])(
    "throws when attachStream (%s) disagrees with an explicit attachStreamToSelf",
    async (_id, attachStream, attachStreamToSelf) => {
      const rest = spyRest("PN1234567890abcdef");
      const adapter = makeAdapterWithRest(rest);
      await adapter.connect();
      openAdapter = adapter;
      adapter._signalStreamConnected();
      await expect(
        adapter.placeCall({ to: "+14155557777", attachStream, attachStreamToSelf }),
      ).rejects.toThrow(/attachStream.*attachStreamToSelf/);
    },
  );

  it("b-leg golden: exact Say+Pause TwiML AND callee REST sequence stay byte-identical", async () => {
    const rest = spyRest("PN1234567890abcdef");
    const adapter = makeAdapterWithRest(rest);
    await adapter.connect();
    // connect() resolves the adapter's own number; slice it off the golden.
    const baseLog = rest.restCallLog.length;
    adapter._signalStreamConnected();
    await adapter.placeCall({ to: "+14155557777" }); // default b-leg
    await adapter.disconnect();

    const expectedBLegTwiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
      `<Say voice="Polly.Joanna">` +
      `Thank you for calling. ` +
      `I will hold the line while you complete your scenario.` +
      `</Say>` +
      `<Pause length="120"/>` +
      `</Response>`;
    expect(
      rest.placeCallArgs[0].twiml,
      "B-leg behaviour changed: origination TwiML no longer byte-identical",
    ).toBe(expectedBLegTwiml);
    const sid = "PN1234567890abcdef";
    expect(
      rest.restCallLog.slice(baseLog),
      "B-leg behaviour changed: callee REST sequence no longer matches golden order",
    ).toEqual([
      ["resolvePhoneNumberSid", ["+14155557777"]],
      ["readVoiceUrl", [sid]],
      ["writeVoiceUrl", [sid, "https://example.test/twilio/voice"]],
      ["writeVoiceUrl", [sid, "https://old-webhook.example.com/previous"]],
    ]);
    expect(
      rest.placeCallArgs[0].timeLimitSeconds,
      "B-leg behaviour changed: origination now carries a TimeLimit; the " +
        "duration cap is a-leg-only (b-leg is bounded by <Pause length=120>)",
    ).toBeUndefined();
  });
});
