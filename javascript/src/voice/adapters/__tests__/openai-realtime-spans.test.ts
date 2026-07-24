/**
 * OpenAIRealtimeAgentAdapter LangWatch/OTel span instrumentation (#770 / #773).
 *
 * Mirrors `test_voice_spans_realtime.py` (Python) and the ElevenLabs PR1
 * slice (#771). Drives the REAL `OpenAIRealtimeAgentAdapter` over an
 * in-process `ws` server (the `newHandle()`/`buildAdapter()` harness from
 * `openai-realtime.test.ts`, copied here) with an `InMemorySpanExporter`
 * (the ALS-context-manager + provider setup from `voice-spans.test.ts`,
 * copied here) capturing the spans the production `call()` / the shared
 * `defaultVoiceCall`/`drainAgentResponse` runtime emit.
 *
 * Per the design spec's load-bearing architectural facts:
 * - AGENT-role `call()` delegates to `super.call()` (= `defaultVoiceCall`),
 *   so the BASE `voice.turn` / `voice.audio.send` / `voice.audio.receive`
 *   spans (and the H2 first-chunk-error ERROR labeling) are INHERITED for
 *   free — R1 and R3 below prove that inheritance holds for this adapter.
 *   Because that base instrumentation already shipped in #771, R1/R3 may
 *   already be GREEN on a pre-#773 tree — that is expected, not a test bug
 *   (see the design doc's "R1 + R3 are INHERITED" note).
 * - `receiveAudio` runs INSIDE the base `voice.audio.receive` span's ambient
 *   context (invoked BY `drainAgentResponse`), so it can stamp markers/attrs
 *   onto `currentSpan()` — the R2 seam R2a/R2b exercise below, genuinely new
 *   (RED before #773).
 * - The USER-role `_autonomousUserTurn` path currently bypasses
 *   `super.call()` entirely and opens NO span at all — R4 is JS-only and
 *   genuinely new (RED before #773): the whole `voice.turn` span doesn't
 *   exist yet on this path.
 *
 * R-regression (existing `openai-realtime*.test.ts` staying green) is not a
 * new test here — the orchestrator runs the existing suite.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";

// Register a context manager ONCE so context.with propagates across awaits —
// receiveAudio's event loop reads currentSpan() after real awaits (the R2
// seam). Without it, context.active() is always root and currentSpan() is
// undefined. Mirrors voice-spans.test.ts.
const _ctxManager = new AsyncLocalStorageContextManager();
_ctxManager.enable();
context.setGlobalContextManager(_ctxManager);

import { AgentRole, type AgentInput } from "../../../domain/agents";
import {
  OPENAI_REALTIME_MODEL,
  OpenAIRealtimeAgentAdapter,
  type OpenAIRealtimeAgentAdapterInit,
  createAudioMessage,
  silentChunk,
  startVoiceAdapters,
  type VoiceExecutorState,
} from "../../index";
import { voiceSpan } from "../../telemetry";

// ---------------------------------------------------------------------------
// In-process ws server harness (copied from openai-realtime.test.ts).
// ---------------------------------------------------------------------------

interface ServerEvent {
  type: string;
  raw: string;
  data: Record<string, unknown>;
}

interface MockHandle {
  port: number;
  events: ServerEvent[];
  push: (payload: unknown) => void;
  socketReady: Promise<void>;
  reset: () => void;
}

let http: Server;
let wss: WebSocketServer;
let activeSocket: WsServerSocket | null = null;
let socketReadyResolve: (() => void) | null = null;
let socketReady: Promise<void> = new Promise((r) => {
  socketReadyResolve = r;
});
let observedEvents: ServerEvent[] = [];

beforeAll(
  async () =>
    await new Promise<void>((doneStart) => {
      http = createServer();
      wss = new WebSocketServer({ server: http });
      wss.on("connection", (sock) => {
        activeSocket = sock;
        if (socketReadyResolve) socketReadyResolve();
        sock.on("message", (raw) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : Buffer.from(raw as ArrayBuffer).toString("utf8");
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(text);
          } catch {
            return;
          }
          observedEvents.push({
            type: String(parsed.type ?? ""),
            raw: text,
            data: parsed,
          });
        });
      });
      http.listen(0, "127.0.0.1", doneStart);
    }),
);

afterAll(async () => {
  wss.close();
  await new Promise<void>((done) => http.close(() => done()));
});

function newHandle(): MockHandle {
  observedEvents = [];
  socketReady = new Promise<void>((r) => {
    socketReadyResolve = r;
  });
  return {
    port: (http.address() as AddressInfo).port,
    events: observedEvents,
    push: (payload) => {
      const sock = activeSocket;
      if (!sock) throw new Error("socket not yet connected");
      sock.send(JSON.stringify(payload));
    },
    get socketReady() {
      return socketReady;
    },
    reset: () => {
      observedEvents.length = 0;
    },
  };
}

/**
 * Build an adapter pre-wired to the in-process WS server via the public
 * `url` init knob. No subclassing — keeps tests against the real surface.
 */
function buildAdapter(
  port: number,
  init: Omit<OpenAIRealtimeAgentAdapterInit, "url">,
): OpenAIRealtimeAgentAdapter {
  return new OpenAIRealtimeAgentAdapter({
    ...init,
    url: `ws://127.0.0.1:${port}/realtime?model=${init.model ?? OPENAI_REALTIME_MODEL}`,
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Connect + wait for the post-connect session.update to land on the wire —
 * avoids racing the test's event pushes against the connect handshake.
 */
async function connectAndAwaitSessionUpdate(
  handle: MockHandle,
  adapter: OpenAIRealtimeAgentAdapter,
): Promise<void> {
  await adapter.connect();
  await handle.socketReady;
  await waitFor(() => handle.events.some((e) => e.type === "session.update"));
}

// ---------------------------------------------------------------------------
// Span + audio helpers (byName copied from voice-spans.test.ts).
// ---------------------------------------------------------------------------

function byName(spans: ReadableSpan[]): Record<string, ReadableSpan> {
  return Object.fromEntries(spans.map((s) => [s.name, s]));
}

function eventNames(span: ReadableSpan): string[] {
  return span.events.map((e) => e.name);
}

/**
 * A tiny valid (even-byte) PCM16 delta, base64-encoded — mirrors the pcm
 * literal already used in openai-realtime.test.ts.
 */
function pcmDeltaB64(): string {
  return Buffer.from(new Uint8Array([0x10, 0x00, 0x20, 0x00])).toString("base64");
}

describe("OpenAIRealtimeAgentAdapter voice.realtime.* span instrumentation (#770 / #773)", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });
  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  // R1 (inherited — see file header) -----------------------------------------
  it("emits base voice.turn/send/receive spans tagged with this adapter's class (AGENT role)", async () => {
    const handle = newHandle();
    const adapter = buildAdapter(handle.port, { apiKey: "test-key", role: AgentRole.AGENT });
    adapter.responseTailSilence = 0.05; // fast tail-silence close — the 0.6s default would slow the suite
    await connectAndAwaitSessionUpdate(handle, adapter);

    const input = {
      newMessages: [createAudioMessage(silentChunk(0.05), "user")],
    } as unknown as AgentInput;
    const callPromise = adapter.call(input);
    handle.push({ type: "response.created" });
    handle.push({ type: "response.output_audio.delta", delta: pcmDeltaB64() });
    handle.push({ type: "response.output_audio_transcript.done", transcript: "hi" });
    handle.push({ type: "response.done" });
    await callPromise;

    const spans = byName(exporter.getFinishedSpans());
    expect(spans["voice.turn"]).toBeDefined();
    expect(spans["voice.audio.send"]).toBeDefined();
    expect(spans["voice.audio.receive"]).toBeDefined();
    expect(spans["voice.turn"].attributes["voice.adapter.class"]).toBe(
      "OpenAIRealtimeAgentAdapter",
    );
    expect(spans["voice.audio.receive"].parentSpanContext?.spanId).toBe(
      spans["voice.turn"].spanContext().spanId,
    );

    await adapter.disconnect();
  });

  // R2a ------------------------------------------------------------------------
  it("stamps voice.realtime.response.created/.done markers + tool_call_count=0 on the receive span", async () => {
    const handle = newHandle();
    const adapter = buildAdapter(handle.port, { apiKey: "test-key", role: AgentRole.AGENT });
    adapter.responseTailSilence = 0.05;
    await connectAndAwaitSessionUpdate(handle, adapter);

    const input = {
      newMessages: [createAudioMessage(silentChunk(0.05), "user")],
    } as unknown as AgentInput;
    const callPromise = adapter.call(input);
    handle.push({ type: "response.created" });
    handle.push({ type: "response.output_audio.delta", delta: pcmDeltaB64() });
    handle.push({ type: "response.output_audio_transcript.done", transcript: "hi" });
    handle.push({ type: "response.done" });
    await callPromise;

    const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
    expect(eventNames(recv)).toEqual(
      expect.arrayContaining(["voice.realtime.response.created", "voice.realtime.response.done"]),
    );
    expect(recv.attributes["voice.realtime.tool_call_count"]).toBe(0);

    await adapter.disconnect();
  });

  // R2b ------------------------------------------------------------------------
  it("counts a tool call finalized before response.done into voice.realtime.tool_call_count", async () => {
    const handle = newHandle();
    const adapter = buildAdapter(handle.port, { apiKey: "test-key", role: AgentRole.AGENT });
    adapter.responseTailSilence = 0.05;
    await connectAndAwaitSessionUpdate(handle, adapter);

    const input = {
      newMessages: [createAudioMessage(silentChunk(0.05), "user")],
    } as unknown as AgentInput;
    const callPromise = adapter.call(input);
    handle.push({ type: "response.created" });
    handle.push({ type: "response.output_audio.delta", delta: pcmDeltaB64() });
    // The call must finalize BEFORE response.done — production stamps the
    // count from a snapshot taken when response.done is processed.
    handle.push({
      type: "response.output_item.added",
      item: { type: "function_call", name: "get_weather", call_id: "call_1" },
    });
    handle.push({
      type: "response.function_call_arguments.delta",
      call_id: "call_1",
      delta: '{"x":1}',
    });
    handle.push({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      arguments: '{"x":1}',
    });
    handle.push({ type: "response.done" });
    await callPromise;

    const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
    expect(recv.attributes["voice.realtime.tool_call_count"]).toBe(1);

    await adapter.disconnect();
  });

  // R2c (interrupt effect: response.cancelled) --------------------------------
  it("stamps voice.realtime.response.cancelled on the receive span (interrupt effect)", async () => {
    const handle = newHandle();
    const adapter = buildAdapter(handle.port, { apiKey: "test-key", role: AgentRole.AGENT });
    adapter.responseTailSilence = 0.05;
    await connectAndAwaitSessionUpdate(handle, adapter);

    const input = {
      newMessages: [createAudioMessage(silentChunk(0.05), "user")],
    } as unknown as AgentInput;
    const callPromise = adapter.call(input);
    handle.push({ type: "response.created" });
    handle.push({ type: "response.output_audio.delta", delta: pcmDeltaB64() });
    handle.push({ type: "response.cancelled" });
    await callPromise;

    const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
    expect(eventNames(recv)).toEqual(
      expect.arrayContaining(["voice.realtime.response.created", "voice.realtime.response.cancelled"]),
    );

    await adapter.disconnect();
  });

  // R3 (inherited — see file header) -----------------------------------------
  it("marks voice.audio.receive ERROR + first_chunk_timeout on a first-chunk failure (AGENT role)", async () => {
    const handle = newHandle();
    const adapter = buildAdapter(handle.port, { apiKey: "test-key", role: AgentRole.AGENT });
    adapter.responseTimeout = 0.3; // fast — the 30s default would hang the suite
    await connectAndAwaitSessionUpdate(handle, adapter);

    const input = {
      newMessages: [createAudioMessage(silentChunk(0.05), "user")],
    } as unknown as AgentInput;
    // Push NOTHING — the first receiveAudio call idles out at responseTimeout.
    await expect(adapter.call(input)).rejects.toThrow();

    const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
    expect(recv.status.code).toBe(SpanStatusCode.ERROR);
    expect(recv.attributes["voice.audio.terminated_reason"]).toBe("first_chunk_timeout");

    await adapter.disconnect();
  });

  // R4 (JS-only, genuinely new — see file header) -----------------------------
  it("wraps the USER-role autonomous turn in its own voice.turn span with the R2 markers on its receive span", async () => {
    const handle = newHandle();
    const adapter = buildAdapter(handle.port, {
      apiKey: "test-key",
      role: AgentRole.USER,
      instructions: "simulate a customer",
    });
    await connectAndAwaitSessionUpdate(handle, adapter);

    // What the agent-under-test just said, which the user simulator "hears".
    const agentAudioMsg = createAudioMessage(silentChunk(0.05), "assistant");
    const input = {
      newMessages: [agentAudioMsg],
      scenarioState: { currentTurn: 2 },
    } as unknown as AgentInput;
    const callPromise = adapter.call(input);
    handle.push({ type: "response.created" });
    handle.push({ type: "response.output_audio.delta", delta: pcmDeltaB64() });
    handle.push({ type: "response.output_audio_transcript.done", transcript: "customer line" });
    handle.push({ type: "response.done" });
    // _drainSpokenTurn's idle timeout is a hardcoded 15s (speakGeneratedUserTurn
    // is called with no override), not sourced from adapter.responseTailSilence —
    // so a real "just stop sending" tail-silence close would hang this test for
    // 15 real seconds. Push a synthetic error event instead: the drain loop
    // treats ANY receiveAudio rejection as "the model stopped talking" (see
    // speakUserTurn's jsdoc), so this ends the ALREADY-drained turn (1 chunk)
    // immediately. The R2 markers/attrs asserted below are already stamped
    // (from the response.created/response.done events above) before this fires.
    handle.push({ type: "error", error: { message: "test: end turn" } });
    await callPromise;

    const spans = byName(exporter.getFinishedSpans());
    const turn = spans["voice.turn"];
    expect(turn).toBeDefined();
    expect(turn.attributes["voice.adapter.class"]).toBe("OpenAIRealtimeAgentAdapter");
    expect(turn.attributes["voice.turn.index"]).toBe(2);
    // _autonomousUserTurn's own voiceSpan("voice.audio.send", ...) wrap around
    // the heard-audio send (new in #773, previously uncovered here): the R4
    // input's agentAudioMsg carries a real 2400-byte silentChunk(0.05), so
    // _extractHeardAudio returns truthy and this span actually emits.
    expect(spans["voice.audio.send"]).toBeDefined();
    expect(spans["voice.audio.send"].parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    const recv = spans["voice.audio.receive"];
    expect(recv).toBeDefined();
    expect(recv.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(eventNames(recv)).toEqual(
      expect.arrayContaining(["voice.realtime.response.created", "voice.realtime.response.done"]),
    );

    await adapter.disconnect();
  });

  // R-connect ------------------------------------------------------------------
  it("stamps voice.realtime.model/session_type/tool_count onto the voice.adapter.connect span", async () => {
    const handle = newHandle();
    const adapter = buildAdapter(handle.port, {
      apiKey: "test-key",
      role: AgentRole.AGENT,
      model: "gpt-realtime-mini",
      tools: [{ type: "function", name: "noop" }],
    });

    // Drives the REAL executor connect loop (startVoiceAdapters) rather than a
    // hand-rolled voiceSpan wrap, so this proves the actual connect-loop
    // wiring — not just this adapter's own attribute-stamping in isolation.
    // `state` is never dereferenced for this adapter: startVoiceAdapters only
    // reads it inside attachVadFallback, which never runs here because
    // capabilities.nativeVad === true — so a minimal stub satisfies the
    // VoiceExecutorState contract without faking a real executor.
    const state: VoiceExecutorState = {
      voiceRecording: null,
      voiceTimeline: null,
      voiceLatency: null,
      voiceRecordingStartedAt: null,
    };
    await startVoiceAdapters([adapter], state);
    await handle.socketReady;
    await waitFor(() => handle.events.some((e) => e.type === "session.update"));

    const connect = byName(exporter.getFinishedSpans())["voice.adapter.connect"];
    expect(connect).toBeDefined();
    expect(connect.attributes["voice.realtime.model"]).toBe("gpt-realtime-mini");
    expect(connect.attributes["voice.realtime.voice"]).toBe("alloy");
    expect(connect.attributes["voice.realtime.session_type"]).toBe("realtime");
    expect(connect.attributes["voice.realtime.tool_count"]).toBe(1);

    await adapter.disconnect();
  });

  // Scripted speakUserTurn path — deliberately uninstrumented (scope guard) ---
  it("emits no voice.audio.receive/voice.turn span for the SCRIPTED speakUserTurn path", async () => {
    const handle = newHandle();
    const adapter = buildAdapter(handle.port, {
      apiKey: "test-key",
      role: AgentRole.USER,
      instructions: "simulate a customer",
    });
    await connectAndAwaitSessionUpdate(handle, adapter);

    const turnPromise = adapter.speakUserTurn("hello");
    handle.push({ type: "response.created" });
    handle.push({ type: "response.output_audio.delta", delta: pcmDeltaB64() });
    handle.push({ type: "response.output_audio_transcript.done", transcript: "hello there" });
    handle.push({ type: "response.done" });
    // _drainSpokenTurn's idle timeout is a hardcoded 15s default (speakUserTurn
    // is called with no override) — a real "just stop sending" tail-silence
    // close would hang this test for 15 real seconds. Push a synthetic error
    // event instead, exactly like the R4 test above: the drain loop treats ANY
    // receiveAudio rejection as "the model stopped talking", so this ends the
    // already-drained turn (1 chunk) immediately. No voice.audio.receive span
    // is ever opened on this path (scope guard) — the assertions below are
    // what that actually means: neither the receive nor the turn span exist.
    handle.push({ type: "error", error: { message: "test: end turn" } });
    await turnPromise;

    const spans = byName(exporter.getFinishedSpans());
    expect(spans["voice.audio.receive"]).toBeUndefined();
    expect(spans["voice.turn"]).toBeUndefined();

    await adapter.disconnect();
  });

  // Security (defense-in-depth deny-list, #773) -------------------------------
  it("does not stamp sensitive data (api key, persona, transcripts, tool arguments) onto any span", async () => {
    // Telemetry exports to LangWatch and this taxonomy is copied by 4 more
    // adapter PRs, so a leak in this shared pattern would ship broadly. Drives
    // a real connect span (key-shaped apiKey + a persona + tools configured)
    // plus a full AGENT turn (which populates a transcript), then scans every
    // finished span for the deny-listed key terms and the literal secret
    // substrings — as an attribute KEY, an attribute VALUE, or an event name.
    const apiKey = "sk-REALKEYSHAPE1234567890";
    const persona = "SECRET_PERSONA_DO_NOT_LEAK";
    const handle = newHandle();
    const adapter = buildAdapter(handle.port, {
      apiKey,
      role: AgentRole.AGENT,
      instructions: persona,
      tools: [{ type: "function", name: "noop" }],
    });
    adapter.responseTailSilence = 0.05;

    await voiceSpan("voice.adapter.connect", {}, async () => {
      await adapter.connect();
    });
    await handle.socketReady;
    await waitFor(() => handle.events.some((e) => e.type === "session.update"));

    const input = {
      newMessages: [createAudioMessage(silentChunk(0.05), "user")],
    } as unknown as AgentInput;
    const callPromise = adapter.call(input);
    handle.push({ type: "response.created" });
    handle.push({ type: "response.output_audio.delta", delta: pcmDeltaB64() });
    handle.push({ type: "response.output_audio_transcript.done", transcript: "hi" });
    handle.push({ type: "response.done" });
    await callPromise;

    const denyListedKeyTerms = [
      "api_key",
      "apikey",
      "authorization",
      "instruction",
      "persona",
      "transcript",
      "arguments",
      "secret",
      "bearer",
    ];

    for (const span of exporter.getFinishedSpans()) {
      for (const [key, value] of Object.entries(span.attributes)) {
        const loweredKey = key.toLowerCase();
        const hitTerm = denyListedKeyTerms.find((term) => loweredKey.includes(term));
        expect(
          hitTerm,
          `span '${span.name}' stamped a deny-listed attribute key: '${key}'`,
        ).toBeUndefined();
        if (typeof value === "string") {
          expect(
            value.includes(apiKey),
            `span '${span.name}' attribute '${key}' leaked the api key: '${value}'`,
          ).toBe(false);
          expect(
            value.includes(persona),
            `span '${span.name}' attribute '${key}' leaked the persona: '${value}'`,
          ).toBe(false);
        }
      }
      for (const name of eventNames(span)) {
        expect(
          name.includes(apiKey),
          `span '${span.name}' event name leaked the api key: '${name}'`,
        ).toBe(false);
        expect(
          name.includes(persona),
          `span '${span.name}' event name leaked the persona: '${name}'`,
        ).toBe(false);
      }
    }

    await adapter.disconnect();
  });
});
