/**
 * TwilioAgentAdapter protocol unit tests — binds the three @integration
 * @ts-bound scenarios tagged @ts-twilio-proto in `specs/voice-agents.feature`.
 *
 * Uses an in-process mock WebSocket so the assertions hit only the adapter's
 * frame parser, capability declaration, and interrupt path — no real HTTP/WS
 * server, no real Twilio.
 */

import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "..", "specs", "voice-agents.feature");

const feature = await loadFeature(FEATURE_PATH);

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
    expect(() => validateE164("+447911123456")).not.toThrow();
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
