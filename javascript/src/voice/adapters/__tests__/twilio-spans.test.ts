/**
 * Twilio-specific voice-span attributes (#770 / #771 taxonomy, #775 scope).
 * TypeScript mirror of `python/tests/voice/test_voice_spans_twilio.py`.
 *
 * Drives the REAL `TwilioAgentAdapter` (REST stubbed via constructor DI,
 * media transport driven through the real `TwilioWebhookServer` loop over a
 * scripted/controllable socket double) through `startVoiceAdapters`/
 * `stopVoiceAdapters` and through `placeCall()`/`waitForCall()` directly,
 * asserting the Twilio contributions this PR adds:
 *
 * - T1: base spans (voice.turn / voice.audio.send / voice.audio.receive) are
 *   NOT hollow for Twilio. REGRESSION GUARD — already GREEN before any #775
 *   instrumentation lands (Twilio's call() is inherited, not overridden).
 * - T2: voice.adapter.connect carries Twilio connect-time config attrs.
 * - T3: voice.adapter.disconnect carries call-lifetime counters (frames,
 *   DTMF, stream-ended reason, REST-restore-failed, webhook invocation/
 *   rejection counts).
 * - T4/T5: a NEW voice.adapter.dial span wraps placeCall() / waitForCall() —
 *   the REST dial + the stream-connected wait.
 * - T6: dial ERROR on a stream-connect timeout (the marquee "I placed the
 *   call but no media ever streamed" failure).
 * - T7: dial ERROR on a REST failure records the ORIGINAL exception.
 * - T8: SKIPPED — see the comment block above the T10 section. The JS OTel
 *   SDK already guards `Span.end()` against a throwing processor (proven in
 *   `voice-spans.test.ts`'s own A7 comment), so a "boom processor at the
 *   dial site" test would be vacuous in TS — it can't fail even against an
 *   adapter with NO dial span at all. Python's T8 is the meaningful test for
 *   this AC.
 * - T9: py<->ts parity — see the comment block near the bottom.
 * - T10: span count is invariant to media-frame count (flood guard).
 *
 * Design doc: sc#775 "Twilio voice-adapter LangWatch spans: design + ACs".
 * Harness patterns copied (not cross-imported — matching this suite's
 * existing per-file `stubRest`/socket-double convention) from
 * `twilio.test.ts` / `twilio-server.test.ts` (`stubRest`) and
 * `twilio-silent-stop-drain.test.ts` (`scriptedSocket` / `controllableSocket`
 * / `driveTwilioProduction`).
 */
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";

// Register a context manager ONCE so context.with propagates across awaits —
// mirrors voice-spans.test.ts (this file's module graph is isolated per
// vitest worker, so each span-test file registers its own).
const _ctxManager = new AsyncLocalStorageContextManager();
_ctxManager.enable();
context.setGlobalContextManager(_ctxManager);

import {
  driveCall,
  driveTwilioProduction,
  makeAgentInput,
} from "../../__tests__/helpers/drive-production";
import { startVoiceAdapters, stopVoiceAdapters } from "../../adapter.runtime";
import { AudioChunk } from "../../audio-chunk";
import type { VoiceExecutorState } from "../../voice-executor-state";
import { TwilioAgentAdapter } from "../twilio";
import type { MediaStreamWebSocket } from "../twilio-server";
import { buildMediaFrame, TwilioRESTHelper } from "../twilio-shared";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const STREAM_SID = "MZ775";
const CALL_SID = "CA775";
const PHONE_NUMBER_SID = "PN" + "0".repeat(32);

function startFrame(streamSid = STREAM_SID, callSid = CALL_SID): string {
  return JSON.stringify({ event: "start", start: { streamSid, callSid } });
}

function stopFrame(): string {
  return JSON.stringify({ event: "stop" });
}

function dtmfFrame(digit: string, streamSid = STREAM_SID): string {
  return JSON.stringify({ event: "dtmf", streamSid, dtmf: { digit } });
}

/** A minimal VoiceExecutorState — only what startVoiceAdapters/VAD-fallback
 * registration touches (nothing, for span-only tests). Mirrors the
 * `makeVoiceState()` pattern in el-audioqueue-turn-boundary.test.ts, trimmed
 * to the empty case since these tests don't exercise recording/VAD. */
function bareVoiceState(): VoiceExecutorState {
  return {} as unknown as VoiceExecutorState;
}

/**
 * A `MediaStreamWebSocket` double whose `receiveText()` serves `frames` in
 * order, then either resolves `null` (socket close) or rejects with
 * `closeWith` (transport error) — the three termination shapes
 * `stream_ended_reason` distinguishes (stop / close / error).
 */
function scriptedSocket(
  frames: string[],
  opts?: { closeWith?: Error },
): MediaStreamWebSocket {
  let idx = 0;
  return {
    send() {
      // Outbound is irrelevant to these tests.
    },
    receiveText() {
      if (idx < frames.length) return Promise.resolve(frames[idx++]!);
      if (opts?.closeWith) return Promise.reject(opts.closeWith);
      return Promise.resolve(null); // socket closed
    },
    close() {
      // No-op for the double.
    },
  };
}

/**
 * A `MediaStreamWebSocket` double the test can feed mid-flight — needed
 * where the media loop must stay LIVE while the test drives a concurrent
 * `call()` (T1). Copied from `twilio-silent-stop-drain.test.ts`.
 */
function controllableSocket(): MediaStreamWebSocket & {
  push(item: string | null | Error): void;
} {
  const queued: Array<string | null | Error> = [];
  const waiters: Array<{
    resolve: (v: string | null) => void;
    reject: (e: Error) => void;
  }> = [];
  return {
    send() {
      // Outbound is irrelevant to these tests.
    },
    close() {
      // No-op for the double.
    },
    push(item: string | null | Error): void {
      const waiter = waiters.shift();
      if (waiter) {
        if (item instanceof Error) waiter.reject(item);
        else waiter.resolve(item);
        return;
      }
      queued.push(item);
    },
    receiveText(): Promise<string | null> {
      if (queued.length > 0) {
        const item = queued.shift()!;
        if (item instanceof Error) return Promise.reject(item);
        return Promise.resolve(item);
      }
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

/** REST double: a real TwilioRESTHelper with network methods replaced.
 * `writeCalls` records every writeVoiceUrl mutation in order (set, restore,
 * ...) — needed by the rest_restore_failed tests. Local copy of the
 * `stubRest` pattern in twilio.test.ts / twilio-server.test.ts, extended
 * with the call log twilio.test.ts doesn't need. */
function stubRest(sid: string): {
  rest: TwilioRESTHelper;
  writeCalls: Array<[string, string]>;
} {
  const rest = new TwilioRESTHelper("ACtest", "secret");
  const writeCalls: Array<[string, string]> = [];
  rest.resolvePhoneNumberSid = async () => sid;
  rest.readVoiceUrl = async () => "https://old-webhook.example.com/previous";
  rest.writeVoiceUrl = async (phoneNumberSid, voiceUrl) => {
    writeCalls.push([phoneNumberSid, voiceUrl]);
  };
  rest.placeCall = async () => "CA" + "1".repeat(32);
  rest.sendDtmfOnCall = async () => undefined;
  return { rest, writeCalls };
}

function makeAdapter(opts?: {
  rest?: TwilioRESTHelper;
  validateSignature?: boolean;
  authToken?: string;
  httpPort?: number;
}): TwilioAgentAdapter {
  return new TwilioAgentAdapter({
    accountSid: "ACtest",
    authToken: opts?.authToken ?? "secret",
    phoneNumber: "+14155551234",
    publicBaseUrl: "https://example.test",
    validateSignature: opts?.validateSignature ?? false,
    httpPort: opts?.httpPort ?? 0,
    rest: opts?.rest ?? stubRest(PHONE_NUMBER_SID).rest,
  });
}

/** HMAC-SHA1(authToken, url + sortedParamsConcat), base64 — mirrors the
 * `signFixture` helper in twilio.test.ts's `verifyTwilioSignature` suite. */
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

function byName(
  spans: ReturnType<InMemorySpanExporter["getFinishedSpans"]>,
): Record<string, (typeof spans)[number]> {
  return Object.fromEntries(spans.map((s) => [s.name, s]));
}

/** Every voice.audio.receive span (base drain + background-loop marker share
 * the same NAME, disambiguated only by voice.twilio.recv.source). */
function receives(
  spans: ReturnType<InMemorySpanExporter["getFinishedSpans"]>,
): ReturnType<InMemorySpanExporter["getFinishedSpans"]> {
  return spans.filter((s) => s.name === "voice.audio.receive");
}

describe("voice.twilio.* span instrumentation (#775)", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  const tracked: TwilioAgentAdapter[] = [];

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });
  afterEach(async () => {
    while (tracked.length > 0) {
      try {
        await tracked.pop()!.disconnect();
      } catch {
        // Best-effort teardown.
      }
    }
    await provider.shutdown();
    trace.disable();
  });

  // --- T1 (regression) -----------------------------------------------------

  it("T1 REGRESSION (already GREEN): a real turn over Twilio emits voice.turn > {send, receive}, voice.adapter.class == TwilioAgentAdapter", async () => {
    const adapter = makeAdapter();
    tracked.push(adapter);
    adapter.responseTailSilence = 0.05; // keep the test fast
    await adapter.connect();
    const socket = controllableSocket();
    const loop = adapter._driveStreamSession(socket);
    socket.push(startFrame());
    await vi.waitFor(() => expect(adapter._streamSidForTest).toBe(STREAM_SID));

    // One real agent-audio media frame >= the 800-byte batch threshold, so it
    // flushes into the inbound queue immediately — deterministic, no sleep-race.
    socket.push(buildMediaFrame(STREAM_SID, new Uint8Array(800).fill(0x7f)));
    await sleep(50); // let the loop task drain the pushed frame

    await driveCall(
      adapter,
      makeAgentInput(new AudioChunk({ data: new Uint8Array(2400) })),
    );

    socket.push(stopFrame());
    await loop;

    const spans = byName(exporter.getFinishedSpans());
    const turn = spans["voice.turn"];
    expect(turn.attributes["voice.adapter.class"]).toBe("TwilioAgentAdapter");
    expect(spans["voice.audio.send"].parentSpanId).toBe(turn.spanContext().spanId);
    expect(spans["voice.audio.receive"].parentSpanId).toBe(turn.spanContext().spanId);
  });

  // --- T2 (connect attrs) ---------------------------------------------------

  describe("T2 — connect attrs", () => {
    it(
      "voice.adapter.connect carries phone_number_sid / validate_signature / webhook_port " +
        "(NOT direction — FLAGGED: connect() is direction-agnostic, mode stays 'idle' " +
        "until placeCall()/waitForCall() picks one AFTER this span has already closed; " +
        "direction is tested on voice.adapter.dial instead — T4/T5 below)",
      async () => {
        const { rest } = stubRest(PHONE_NUMBER_SID);
        const adapter = makeAdapter({ rest, validateSignature: true, httpPort: 0 });
        tracked.push(adapter);

        await startVoiceAdapters([adapter], bareVoiceState());
        const connect = byName(exporter.getFinishedSpans())["voice.adapter.connect"];
        expect(connect.attributes["voice.adapter.class"]).toBe("TwilioAgentAdapter");
        expect(connect.attributes["voice.twilio.phone_number_sid"]).toBe(
          PHONE_NUMBER_SID,
        );
        expect(connect.attributes["voice.twilio.validate_signature"]).toBe(true);
        expect(connect.attributes["voice.twilio.webhook_port"]).toBe(0);
      },
    );
  });

  // --- T3 (disconnect counters) ---------------------------------------------

  describe("T3 — disconnect counters", () => {
    it("carries frames_received / dtmf_received / stream_ended_reason=='stop' from a deterministic N=3/M=2 script", async () => {
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      await startVoiceAdapters([adapter], bareVoiceState());

      const frames = [
        startFrame(),
        buildMediaFrame(STREAM_SID, new Uint8Array(160).fill(0x7f)),
        buildMediaFrame(STREAM_SID, new Uint8Array(160).fill(0x7f)),
        buildMediaFrame(STREAM_SID, new Uint8Array(160).fill(0x7f)),
        dtmfFrame("1"),
        dtmfFrame("5"),
        stopFrame(),
      ];
      await driveTwilioProduction(adapter, scriptedSocket(frames));
      await stopVoiceAdapters([adapter]);

      const disconnect = byName(exporter.getFinishedSpans())["voice.adapter.disconnect"];
      expect(disconnect.attributes["voice.twilio.frames_received"]).toBe(3);
      expect(disconnect.attributes["voice.twilio.dtmf_received"]).toBe(2);
      expect(disconnect.attributes["voice.twilio.stream_ended_reason"]).toBe("stop");
    });

    it("records stream_ended_reason=='close' on a socket close with no stop frame", async () => {
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      await startVoiceAdapters([adapter], bareVoiceState());

      await driveTwilioProduction(adapter, scriptedSocket([startFrame()]));
      await stopVoiceAdapters([adapter]);

      const disconnect = byName(exporter.getFinishedSpans())["voice.adapter.disconnect"];
      expect(disconnect.attributes["voice.twilio.stream_ended_reason"]).toBe("close");
    });

    it("records stream_ended_reason=='error' on a non-disconnect transport error", async () => {
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      await startVoiceAdapters([adapter], bareVoiceState());

      await expect(
        driveTwilioProduction(
          adapter,
          scriptedSocket([startFrame()], {
            closeWith: new Error("boom: transport failure"),
          }),
        ),
      ).rejects.toThrow("boom: transport failure");
      await stopVoiceAdapters([adapter]);

      const disconnect = byName(exporter.getFinishedSpans())["voice.adapter.disconnect"];
      expect(disconnect.attributes["voice.twilio.stream_ended_reason"]).toBe("error");
    });

    it("records stream_ended_reason=='none' when no media session ever ran", async () => {
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      await startVoiceAdapters([adapter], bareVoiceState());
      await stopVoiceAdapters([adapter]);

      const disconnect = byName(exporter.getFinishedSpans())["voice.adapter.disconnect"];
      expect(disconnect.attributes["voice.twilio.stream_ended_reason"]).toBe("none");
    });

    it("carries webhook_invocations==2 / webhook_rejected==1 from one unsigned + one validly-signed POST", async () => {
      const authToken = "the-shared-secret";
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest, validateSignature: true, authToken, httpPort: 0 });
      tracked.push(adapter);
      await startVoiceAdapters([adapter], bareVoiceState());

      // 1. Unsigned -> rejected (403).
      const form = new URLSearchParams({ From: "+14155551234" });
      const r1 = await fetch(`${adapter.localBaseUrl}/twilio/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      await r1.text();
      expect(r1.status).toBe(403);

      // 2. Validly signed (against publicBaseUrl, which the server uses for
      // signature reconstruction) -> accepted (200).
      const params = { From: "+14155551234" };
      const signature = await signFixture({
        authToken,
        url: `${adapter.publicBaseUrl}/twilio/voice`,
        params,
      });
      const r2 = await fetch(`${adapter.localBaseUrl}/twilio/voice`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": signature,
        },
        body: new URLSearchParams(params).toString(),
      });
      await r2.text();
      expect(r2.status).toBe(200);

      await stopVoiceAdapters([adapter]);

      const disconnect = byName(exporter.getFinishedSpans())["voice.adapter.disconnect"];
      expect(disconnect.attributes["voice.twilio.webhook_invocations"]).toBe(2);
      expect(disconnect.attributes["voice.twilio.webhook_rejected"]).toBe(1);
    });

    it("reports rest_restore_failed==false on a clean answer-mode restore", async () => {
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      await startVoiceAdapters([adapter], bareVoiceState());
      adapter._signalStreamConnected();
      await adapter.waitForCall();

      await stopVoiceAdapters([adapter]);

      const disconnect = byName(exporter.getFinishedSpans())["voice.adapter.disconnect"];
      expect(disconnect.attributes["voice.twilio.rest_restore_failed"]).toBe(false);
    });

    it("reports rest_restore_failed==true when the REST restore call throws (swallowed, run continues)", async () => {
      const { rest, writeCalls } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      await startVoiceAdapters([adapter], bareVoiceState());
      adapter._signalStreamConnected();
      await adapter.waitForCall();

      const originalWrite = rest.writeVoiceUrl.bind(rest);
      rest.writeVoiceUrl = async (sid, url) => {
        await originalWrite(sid, url);
        if (writeCalls.length === 2) {
          // The restore call, not the initial set.
          throw new Error("simulated Twilio REST outage");
        }
      };

      await stopVoiceAdapters([adapter]); // must not throw despite the injected failure

      const disconnect = byName(exporter.getFinishedSpans())["voice.adapter.disconnect"];
      expect(disconnect.attributes["voice.twilio.rest_restore_failed"]).toBe(true);
    });

    it("resets webhook_invocations / webhook_rejected across a reconnect on the same instance (MUST-FIX #788 review: rejectedCount previously leaked)", async () => {
      const authToken = "the-shared-secret";
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest, validateSignature: true, authToken, httpPort: 0 });
      tracked.push(adapter);

      // Session 1: one unsigned POST -> rejected.
      await startVoiceAdapters([adapter], bareVoiceState());
      const form = new URLSearchParams({ From: "+14155551234" });
      const r1 = await fetch(`${adapter.localBaseUrl}/twilio/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      await r1.text();
      expect(r1.status).toBe(403);
      await stopVoiceAdapters([adapter]);

      const disconnect1 = byName(exporter.getFinishedSpans())["voice.adapter.disconnect"];
      expect(disconnect1.attributes["voice.twilio.webhook_invocations"]).toBe(1);
      expect(disconnect1.attributes["voice.twilio.webhook_rejected"]).toBe(1);

      // Session 2: reconnect the SAME instance, make ZERO webhook calls. Prior
      // to the fix, `rejectedCount` (the webhook_rejected source) was never
      // reset in connect()/disconnect() — unlike every other Tier-2b counter
      // — so this session's disconnect span still reported the stale 1 from
      // session 1.
      //
      // disconnect() nulls the injected REST stub as part of its normal full
      // teardown (unrelated to this fix), so connect() would otherwise build
      // a REAL TwilioRESTHelper hitting the live API on the reconnect. Patch
      // the prototype for the duration of session 2 so it stays hermetic too
      // — mirroring what constructing a second stubbed adapter would give it.
      const originalResolve = TwilioRESTHelper.prototype.resolvePhoneNumberSid;
      TwilioRESTHelper.prototype.resolvePhoneNumberSid = async () => PHONE_NUMBER_SID;
      try {
        await startVoiceAdapters([adapter], bareVoiceState());
        await stopVoiceAdapters([adapter]);
      } finally {
        TwilioRESTHelper.prototype.resolvePhoneNumberSid = originalResolve;
      }

      const disconnectSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === "voice.adapter.disconnect");
      expect(disconnectSpans).toHaveLength(2);
      const disconnect2 = disconnectSpans[1]!;
      expect(disconnect2.attributes["voice.twilio.webhook_invocations"]).toBe(0);
      expect(disconnect2.attributes["voice.twilio.webhook_rejected"]).toBe(0);
    });

    it(
      "stream_ended_reason reflects the ACTUAL close (not a pre-teardown snapshot) when the call " +
        "is still live at disconnect() time (MUST-FIX #788 review, regression)",
      async () => {
        // Every other T3 test above pre-drives its socket double to a
        // natural stop/close/error completion BEFORE calling disconnect() —
        // which dodges this exact race (reviewer-reproduced empirically).
        // This test instead keeps a REAL WebSocket connection open with real
        // media flowing and NO terminal frame, then runs the REAL
        // stopVoiceAdapters teardown while the call is genuinely still live
        // — so the server-shutdown inside disconnect() (`webhookServer.stop()`,
        // which closes every open `wss` client) is what forces the closure
        // the span must observe. A fake `MediaStreamWebSocket` double can't
        // discriminate this: `stop()` only closes REAL `wss` clients, so a
        // fake socket fed via `_driveStreamSession` is never affected
        // regardless of stamp ordering. Only a REAL `ws` client makes the
        // shutdown-await the thing that closes the stream — exactly the
        // mechanism the bug is about.
        //
        // FALSIFIER: on the pre-fix code (the counter stamp BEFORE
        // `webhookServer.stop()`), this fails —
        // stream_ended_reason=="none" — because the media loop hasn't
        // reacted to the shutdown yet when the span is stamped. Fixed code
        // stamps AFTER stop() and passes.
        const { rest } = stubRest(PHONE_NUMBER_SID);
        const adapter = makeAdapter({ rest, httpPort: 0 });
        tracked.push(adapter);
        await startVoiceAdapters([adapter], bareVoiceState());

        const wsUrl = `${adapter.localBaseUrl.replace(/^http:/, "ws:")}/twilio/stream`;
        const client = await new Promise<WebSocket>((resolve, reject) => {
          const c = new WebSocket(wsUrl);
          c.once("open", () => resolve(c));
          c.once("error", reject);
        });
        client.send(startFrame());
        await vi.waitFor(() => expect(adapter._streamSidForTest).toBe(STREAM_SID));

        // Three individually-flushing media frames — NO stop frame. The
        // stream is still LIVE when teardown begins below.
        for (let i = 0; i < 3; i++) {
          client.send(buildMediaFrame(STREAM_SID, new Uint8Array(800).fill(0x7f)));
        }
        // Poll for the REAL server-side loop to actually decode+enqueue what
        // was sent over the wire (real TCP, not an in-process queue) —
        // avoids a flaky blind sleep.
        await vi.waitFor(() => expect(adapter._framesReceivedForTest).toBe(3));

        // The REAL teardown, invoked while the socket is STILL open — nobody
        // sent a stop frame or closed the connection. disconnect()'s own
        // server-shutdown is what forces the close.
        await stopVoiceAdapters([adapter]);
        client.close();

        const disconnect = byName(exporter.getFinishedSpans())["voice.adapter.disconnect"];
        expect(disconnect.attributes["voice.twilio.frames_received"]).toBe(3);
        expect(disconnect.attributes["voice.twilio.stream_ended_reason"]).not.toBe("none");
      },
    );
  });

  // --- T4 / T5 (dial OK) -----------------------------------------------------

  describe("T4 / T5 — dial OK", () => {
    it("T4: placeCall emits ONE voice.adapter.dial span, OK, outbound, call_sid set, latency present, no timeout outcome", async () => {
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      await adapter.connect();
      adapter._signalStreamConnected(); // pre-fire: stream "already" connected
      await adapter.placeCall({ to: "+14155557777" });

      const dialSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === "voice.adapter.dial");
      expect(dialSpans).toHaveLength(1);
      const dial = dialSpans[0]!;
      expect(dial.status.code).not.toBe(SpanStatusCode.ERROR);
      expect(dial.attributes["voice.adapter.class"]).toBe("TwilioAgentAdapter");
      expect(dial.attributes["voice.twilio.direction"]).toBe("outbound");
      expect(dial.attributes["voice.twilio.call_sid"]).toBe("CA" + "1".repeat(32));
      expect(dial.attributes["voice.twilio.stream_connect_latency_ms"]).toBeTypeOf(
        "number",
      );
      expect(dial.attributes["voice.twilio.dial_outcome"]).not.toBe(
        "stream_connect_timeout",
      );
      // PII note (flagged in the final report): asserted redaction-tolerantly —
      // passes whether the eventual impl stores the raw E.164 or a
      // redactE164-style last-4 form.
      expect(String(dial.attributes["voice.twilio.to"])).toMatch(/7777$/);
      expect(String(dial.attributes["voice.twilio.from"])).toMatch(/1234$/);
    });

    it("T5: waitForCall emits voice.adapter.dial, direction=='inbound'", async () => {
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      await adapter.connect();
      adapter._signalStreamConnected();
      await adapter.waitForCall();

      const dial = byName(exporter.getFinishedSpans())["voice.adapter.dial"];
      expect(dial, "expected a voice.adapter.dial span").toBeDefined();
      expect(dial.status.code).not.toBe(SpanStatusCode.ERROR);
      expect(dial.attributes["voice.twilio.direction"]).toBe("inbound");
    });
  });

  // --- T6 (dial ERROR, marquee: stream_connect_timeout) ----------------------

  it("T6 MARQUEE: a stream-connect timeout marks voice.adapter.dial ERROR with dial_outcome=='stream_connect_timeout'", async () => {
    const { rest } = stubRest(PHONE_NUMBER_SID);
    const adapter = makeAdapter({ rest });
    tracked.push(adapter);
    await adapter.connect();
    // Do NOT signal stream-connected — placeCall must time out.
    await expect(
      adapter.placeCall({ to: "+14155557777", timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);

    const dial = byName(exporter.getFinishedSpans())["voice.adapter.dial"];
    expect(dial, "expected a voice.adapter.dial span").toBeDefined();
    expect(dial.status.code).toBe(SpanStatusCode.ERROR);
    expect(dial.attributes["voice.twilio.dial_outcome"]).toBe("stream_connect_timeout");
  });

  // --- T7 (dial ERROR, REST failure — original exception) ---------------------

  it("T7: a REST failure inside placeCall marks voice.adapter.dial ERROR and records the ORIGINAL exception", async () => {
    const { rest } = stubRest(PHONE_NUMBER_SID);
    rest.placeCall = async () => {
      throw new Error("Twilio REST: rate limited");
    };
    const adapter = makeAdapter({ rest });
    tracked.push(adapter);
    await adapter.connect();

    await expect(adapter.placeCall({ to: "+14155557777" })).rejects.toThrow(
      "Twilio REST: rate limited",
    );

    const dial = byName(exporter.getFinishedSpans())["voice.adapter.dial"];
    expect(dial, "expected a voice.adapter.dial span").toBeDefined();
    expect(dial.status.code).toBe(SpanStatusCode.ERROR);
    const exceptionEvents = dial.events.filter((e) => e.name === "exception");
    expect(exceptionEvents.length).toBeGreaterThan(0);
    const last = exceptionEvents.at(-1)!;
    expect(last.attributes?.["exception.type"]).toBe("Error");
    expect(String(last.attributes?.["exception.message"])).toContain("rate limited");
  });

  // T8 (never-break safety) is intentionally NOT mirrored here — see the
  // module docstring above. The JS OTel SDK's Span.end() already guards a
  // throwing SpanProcessor.onEnd internally (voice-spans.test.ts's own A7
  // comment: "Span.end() already guards processor.onEnd internally, so the
  // run is safe via the SDK here"), so a "boom processor at voice.adapter.dial"
  // test would pass identically whether or not voice.adapter.dial exists at
  // all — it cannot discriminate RED from GREEN and would be a hollow test.
  // Python's T8 is where this guard is genuinely exercised (raw `span.end()`
  // is UNGUARDED there). Flagged in the final report rather than shipped as a
  // vacuous "pass".

  // --- T9 (py<->ts parity) -----------------------------------------------------
  //
  // Not independently testable inside one language's suite. Parity is
  // enforced by this file AND python/tests/voice/test_voice_spans_twilio.py
  // hard-coding the IDENTICAL span name ("voice.adapter.dial") and
  // attribute-key strings: "voice.twilio.direction",
  // "voice.twilio.phone_number_sid", "voice.twilio.validate_signature",
  // "voice.twilio.webhook_port", "voice.twilio.frames_received",
  // "voice.twilio.dtmf_received", "voice.twilio.stream_ended_reason",
  // "voice.twilio.rest_restore_failed", "voice.twilio.webhook_invocations",
  // "voice.twilio.webhook_rejected", "voice.twilio.to", "voice.twilio.from",
  // "voice.twilio.call_sid", "voice.twilio.stream_connect_latency_ms",
  // "voice.twilio.dial_outcome". A renamed key in either language's
  // implementation fails THAT language's own suite — that divergence IS the
  // falsifier.

  // --- T10 (no per-frame spans / flood guard) -----------------------------------

  describe("T10 — flood guard", () => {
    it("span count from a connect->media-loop->disconnect cycle is invariant to media-frame count", async () => {
      // NOTE (honesty flag, not oversold as RED): with only the two lifecycle
      // spans in play, this already holds true pre-#775 (2 spans regardless
      // of N) — on its own it does not discriminate RED/GREEN for this PR.
      // It is a forward flood-guard protecting the T3 counter implementation
      // from regressing into a per-frame-span design.
      async function run(nFrames: number): Promise<number> {
        await provider.shutdown();
        trace.disable();
        exporter = new InMemorySpanExporter();
        provider = new NodeTracerProvider({
          spanProcessors: [new SimpleSpanProcessor(exporter)],
        });
        trace.setGlobalTracerProvider(provider);

        const { rest } = stubRest(PHONE_NUMBER_SID);
        const adapter = makeAdapter({ rest });
        tracked.push(adapter);
        await startVoiceAdapters([adapter], bareVoiceState());
        const frames = [
          startFrame(),
          ...Array.from({ length: nFrames }, () =>
            buildMediaFrame(STREAM_SID, new Uint8Array(160).fill(0x7f)),
          ),
          stopFrame(),
        ];
        await driveTwilioProduction(adapter, scriptedSocket(frames));
        await stopVoiceAdapters([adapter]);
        return exporter
          .getFinishedSpans()
          .filter((s) => s.name.startsWith("voice.")).length;
      }

      const few = await run(3);
      const many = await run(30);
      expect(few).toBe(many);
      expect(few).toBe(2);
    });
  });

  // --- T11 (Tier 3 — background-loop delivery markers, #781/#774 base) ---------
  //
  // #781 rebased Twilio onto #774's reusable primitive: base `defaultVoiceCall`
  // publishes the live `voice.turn` OTel context onto `adapter._voiceTurnContext`
  // (cleared in a `finally`); a background-receive-loop adapter parents a
  // detached-task delivery marker span under it via
  // `voiceReceiveSpanUnder(parent, attrs, fn)`. Mirrors `pipecat-spans.test.ts`'s
  // P2 suite one-to-one, swapping `voice.pipecat.recv.source` ->
  // `voice.twilio.recv.source`. Unlike Pipecat-TS (a synchronous ws `message`
  // callback), Twilio's `mediaStreamLoop` is a genuine async loop — the same
  // queue/task shape as Python — so the ordering trick below (not Pipecat-TS's
  // "emit synchronously mid-call") is what applies here.
  //
  // Ordering trick (mirrors the Python T11 suite): `defaultVoiceCall` publishes
  // `_voiceTurnContext` SYNCHRONOUSLY, before its first genuine await (the
  // frame-pacing `sleep` inside `sendAudio`, or — for a no-incoming turn — the
  // first `receiveAudio` wait inside the drain). The background loop task is
  // already parked on `receiveText()` and can only resume once `call()` actually
  // yields, so a frame pushed into the `controllableSocket()` queue immediately
  // before `await driveCall(...)` is decoded by the loop AFTER the turn context
  // is live (T11a/T11b). Pushing the frame earlier, with an intervening
  // `await sleep(...)` BEFORE `call()` ever starts (T11c/T11d), instead lets the
  // loop decode+enqueue it with NO turn live — the complementary case.
  describe("T11 — Tier 3 background-loop delivery markers", () => {
    it("T11a (Tier-3 core, mirrors Pipecat P2): background media loop emits voice.audio.receive parented to the live turn", async () => {
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      adapter.responseTailSilence = 0.05; // keep the test fast
      await adapter.connect();
      const socket = controllableSocket();
      const loop = adapter._driveStreamSession(socket);
      socket.push(startFrame());
      await vi.waitFor(() => expect(adapter._streamSidForTest).toBe(STREAM_SID));

      // Push ONE agent-audio frame, THEN IMMEDIATELY start the turn — see the
      // ordering-trick note above.
      socket.push(buildMediaFrame(STREAM_SID, new Uint8Array(800).fill(0x7f)));
      await driveCall(
        adapter,
        makeAgentInput(new AudioChunk({ data: new Uint8Array(2400) })),
      );

      socket.push(stopFrame());
      await loop;

      const spans = exporter.getFinishedSpans();
      const turn = byName(spans)["voice.turn"];
      const bg = receives(spans).filter(
        (s) => s.attributes["voice.twilio.recv.source"] === "background_loop",
      );
      expect(bg.length).toBeGreaterThanOrEqual(1);
      // Core assertion: parented directly under the turn, NOT a detached/closed
      // span (the loop's frozen scheduling-time context).
      expect(bg[0].parentSpanId).toBe(turn.spanContext().spanId);
      expect(bg[0].attributes["voice.audio.bytes"]).toBeGreaterThan(0);
    });

    it("T11b (Tier-3 flood-guard, mirrors Pipecat P2): three deliveries within one live turn emit exactly ONE background span", async () => {
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      adapter.responseTailSilence = 0.05;
      await adapter.connect();
      const socket = controllableSocket();
      const loop = adapter._driveStreamSession(socket);
      socket.push(startFrame());
      await vi.waitFor(() => expect(adapter._streamSidForTest).toBe(STREAM_SID));

      for (let i = 0; i < 3; i++) {
        // three 800-byte (individually-flushing) frames, one turn
        socket.push(buildMediaFrame(STREAM_SID, new Uint8Array(800).fill(0x7f)));
      }
      await driveCall(
        adapter,
        makeAgentInput(new AudioChunk({ data: new Uint8Array(2400) })),
      );

      socket.push(stopFrame());
      await loop;

      const bg = receives(exporter.getFinishedSpans()).filter(
        (s) => s.attributes["voice.twilio.recv.source"] === "background_loop",
      );
      expect(bg).toHaveLength(1);
    });

    it("T11c (turn-liveness gate boundary, mirrors Pipecat's review-F2/F3 test): a pre-buffered turn has a base receive span but no background marker", async () => {
      // FLAG (mirrors the T1/T10 honesty pattern from the earlier report): this
      // assertion holds both BEFORE and AFTER a correct Tier-3 implementation —
      // nothing here exercises the marker's presence, only its correct absence.
      // It is a forward regression guard against an over-eager implementation
      // that ignores the turn-liveness gate, not a RED discriminator for
      // Tier-3's initial existence. T11a/T11b are the RED discriminators for
      // that (confirmed empirically — see the RED run below).
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      adapter.responseTailSilence = 0.05;
      await adapter.connect();
      const socket = controllableSocket();
      const loop = adapter._driveStreamSession(socket);
      socket.push(startFrame());
      await vi.waitFor(() => expect(adapter._streamSidForTest).toBe(STREAM_SID));

      socket.push(buildMediaFrame(STREAM_SID, new Uint8Array(800).fill(0x7f)));
      await sleep(50); // let the loop decode+enqueue with NO turn live

      await driveCall(
        adapter,
        makeAgentInput(new AudioChunk({ data: new Uint8Array(2400) })),
      ); // drains the pre-buffered chunk

      socket.push(stopFrame());
      await loop;

      const spans = exporter.getFinishedSpans();
      const base = receives(spans).filter(
        (s) => s.attributes["voice.twilio.recv.source"] !== "background_loop",
      );
      const bg = receives(spans).filter(
        (s) => s.attributes["voice.twilio.recv.source"] === "background_loop",
      );
      expect(base.length).toBeGreaterThanOrEqual(1);
      expect(bg).toHaveLength(0);
    });

    it("T11d (regression, mirrors Pipecat's P-regression test): a frame delivered with no active turn emits no background span", async () => {
      // FLAG (same caveat as T11c): GREEN both before and after a correct
      // implementation — a forward guard, not a RED discriminator.
      const { rest } = stubRest(PHONE_NUMBER_SID);
      const adapter = makeAdapter({ rest });
      tracked.push(adapter);
      await adapter.connect();
      const socket = controllableSocket();
      const loop = adapter._driveStreamSession(socket);
      socket.push(startFrame());
      await vi.waitFor(() => expect(adapter._streamSidForTest).toBe(STREAM_SID));

      // No call() in flight -> _voiceTurnContext is undefined -> the loop
      // buffers the decoded chunk but must emit no span.
      socket.push(buildMediaFrame(STREAM_SID, new Uint8Array(800).fill(0x7f)));
      await sleep(50); // let the background loop process the frame

      socket.push(stopFrame());
      await loop;

      const bg = receives(exporter.getFinishedSpans()).filter(
        (s) => s.attributes["voice.twilio.recv.source"] === "background_loop",
      );
      expect(bg).toHaveLength(0);
    });
  });
});
