/**
 * Pipecat-specific voice-span tests (#770 / #774, PR4). TypeScript mirror of
 * `python/tests/voice/test_voice_spans_pipecat.py`.
 *
 * Drives the REAL `PipecatAgentAdapter` (base `defaultVoiceCall`/drain + the
 * background `onMessage` receive callback) against a fake WebSocket, asserting:
 *  - P1 — a Pipecat turn emits the #771 base spans with class = Pipecat, and the
 *    connect span carries the Pipecat transport attrs.
 *  - P2 — the background receive callback emits a `voice.audio.receive` span
 *    parented to the turn (not detached/closed). Core AC: proves the
 *    context-capture pattern Twilio (#770 PR5) reuses.
 *  - P3 — a receive timeout marks `voice.audio.receive` ERROR.
 *  - P-regression — no orphaned/leaked span from the background callback on
 *    disconnect.
 *
 * Mic-free: an InMemorySpanExporter captures spans from the real production
 * code; only the vendor WebSocket is faked.
 */
import { Buffer } from "node:buffer";

import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Register a context manager ONCE so context.with propagates across awaits (the
// receive-loop parenting under test depends on it). Mirrors voice-spans.test.ts.
const _ctxManager = new AsyncLocalStorageContextManager();
_ctxManager.enable();
context.setGlobalContextManager(_ctxManager);

import { type AgentInput } from "../../../domain/agents";
import {
  startVoiceAdapters,
  stopVoiceAdapters,
} from "../../adapter.runtime";
import { AudioChunk } from "../../audio-chunk";
import { createAudioMessage } from "../../messages";
import { type VoiceExecutorState } from "../../voice-executor-state";
import { PipecatAgentAdapter, type PipecatWebSocketLike } from "../pipecat";
import { pcm16ToMulaw } from "../twilio-shared";

/** Fake ws.WebSocket: captures outbound, pushes inbound via emit(). */
class FakeWebSocket implements PipecatWebSocketLike {
  readonly sent: string[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  send(data: string | Uint8Array): void {
    this.sent.push(
      typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
    );
  }
  close(): void {
    this.emit("close", undefined);
  }
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "open", listener: () => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, listener: (...args: any[]) => void): this {
    const wrapped = (...args: unknown[]): void => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event as "open", wrapped as () => void);
  }
  removeAllListeners(event?: string): this {
    if (event) this.listeners[event] = [];
    else this.listeners = {};
    return this;
  }
  emit(event: string, arg: unknown): void {
    for (const l of [...(this.listeners[event] ?? [])]) l(arg);
  }
  private off(event: string, listener: (...args: unknown[]) => void): void {
    const arr = this.listeners[event];
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
  }
}

const SR = 24000;

function tone(seconds: number): AudioChunk {
  const data = new Uint8Array(Math.round(seconds * SR) * 2);
  for (let i = 0; i < data.length; i++) data[i] = (i % 250) + 1;
  return new AudioChunk({ data });
}

/** One coalesced inbound chunk: ~100 ms of µ-law (>= 800 bytes) as a media frame. */
function inboundMediaFrame(streamSid: string): string {
  const pcm8k = new Uint8Array(1600); // 800 samples @ 8 kHz PCM16 → 800 µ-law bytes
  const view = new DataView(pcm8k.buffer);
  for (let i = 0; i < 800; i++) view.setInt16(i * 2, 3000, true);
  const mulaw = pcm16ToMulaw(pcm8k);
  return JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: Buffer.from(mulaw).toString("base64") },
  });
}

function audioInput(incoming?: AudioChunk): AgentInput {
  const newMessages = incoming ? [createAudioMessage(incoming, "user")] : [];
  return { newMessages } as unknown as AgentInput;
}

function byName(spans: ReadableSpan[]): Record<string, ReadableSpan> {
  return Object.fromEntries(spans.map((s) => [s.name, s]));
}

function receives(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter((s) => s.name === "voice.audio.receive");
}

function makeAdapter(socketRef: { ws?: FakeWebSocket }): PipecatAgentAdapter {
  return new PipecatAgentAdapter({
    url: "ws://bot/ws",
    streamSid: "MZtest",
    callSid: "CAtest",
    realTimePacing: false,
    webSocketFactory: () => {
      const ws = new FakeWebSocket();
      socketRef.ws = ws;
      queueMicrotask(() => ws.emit("open", undefined));
      return ws;
    },
  });
}

describe("Pipecat voice.* span instrumentation (#774)", () => {
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

  // P1 — base spans + class
  it("emits the base spans for a Pipecat turn with class = Pipecat", async () => {
    const ref: { ws?: FakeWebSocket } = {};
    const adapter = makeAdapter(ref);
    (adapter as unknown as { responseTailSilence: number }).responseTailSilence = 0.05;
    await adapter.connect();
    ref.ws!.emit("message", inboundMediaFrame("MZtest")); // buffered agent chunk
    await adapter.call(audioInput(tone(0.05)));
    await adapter.disconnect();

    const spans = byName(exporter.getFinishedSpans());
    expect(spans["voice.turn"]).toBeDefined();
    expect(spans["voice.audio.send"]).toBeDefined();
    expect(spans["voice.audio.receive"]).toBeDefined();
    expect(spans["voice.turn"].attributes["voice.adapter.class"]).toBe(
      "PipecatAgentAdapter",
    );
  });

  // P1 — connect span carries transport attrs (driven through the real executor seam)
  it("stamps voice.pipecat.transport onto the connect span", async () => {
    const ref: { ws?: FakeWebSocket } = {};
    const adapter = makeAdapter(ref);
    await startVoiceAdapters([adapter], {} as unknown as VoiceExecutorState);
    await stopVoiceAdapters([adapter]);

    const connect = byName(exporter.getFinishedSpans())["voice.adapter.connect"];
    expect(connect.attributes["voice.adapter.class"]).toBe("PipecatAgentAdapter");
    expect(connect.attributes["voice.pipecat.transport"]).toBe("websocket");
    expect(connect.attributes["voice.pipecat.transport_format"]).toBe("mulaw/8000");
  });

  // P2 (core) — background callback emits a receive span parented to the turn
  it("parents the background-callback voice.audio.receive span under the turn", async () => {
    const ref: { ws?: FakeWebSocket } = {};
    const adapter = makeAdapter(ref);
    (adapter as unknown as { responseTailSilence: number }).responseTailSilence = 0.05;
    await adapter.connect();
    // Start the turn: call() publishes _voiceTurnContext SYNCHRONOUSLY before its
    // first await. Deliver the agent chunk now → the onMessage callback decodes
    // it under a LIVE turn.
    const call = adapter.call(audioInput(tone(0.05)));
    ref.ws!.emit("message", inboundMediaFrame("MZtest"));
    await call;
    await adapter.disconnect();

    const spans = exporter.getFinishedSpans();
    const turn = byName(spans)["voice.turn"];
    const bg = receives(spans).filter(
      (s) => s.attributes["voice.pipecat.recv.source"] === "background_loop",
    );
    expect(bg.length).toBeGreaterThanOrEqual(1);
    // Core AC: parented directly under the turn, not a detached/root span.
    expect(bg[0].parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(bg[0].attributes["voice.audio.bytes"]).toBeGreaterThan(0);
  });

  // P2 flood-guard — one background span per turn, invariant to chunk count
  it("emits at most one background span per turn (invariant to chunk count)", async () => {
    const ref: { ws?: FakeWebSocket } = {};
    const adapter = makeAdapter(ref);
    (adapter as unknown as { responseTailSilence: number }).responseTailSilence = 0.05;
    await adapter.connect();
    const call = adapter.call(audioInput(tone(0.05)));
    for (let i = 0; i < 3; i++) ref.ws!.emit("message", inboundMediaFrame("MZtest"));
    await call;
    await adapter.disconnect();

    const bg = receives(exporter.getFinishedSpans()).filter(
      (s) => s.attributes["voice.pipecat.recv.source"] === "background_loop",
    );
    expect(bg).toHaveLength(1);
  });

  // Documents the turn-liveness gate limit (review F3): a turn drained from
  // pre-buffered audio (delivered before the turn context was published) gets no
  // background marker; the base receive span still covers it.
  it("emits no background span for a turn drained from pre-buffered audio", async () => {
    const ref: { ws?: FakeWebSocket } = {};
    const adapter = makeAdapter(ref);
    (adapter as unknown as { responseTailSilence: number }).responseTailSilence = 0.05;
    await adapter.connect();
    ref.ws!.emit("message", inboundMediaFrame("MZtest")); // enqueued BEFORE call()
    await adapter.call(audioInput(tone(0.05))); // drains the pre-buffered chunk
    await adapter.disconnect();

    const spans = exporter.getFinishedSpans();
    const bg = receives(spans).filter(
      (s) => s.attributes["voice.pipecat.recv.source"] === "background_loop",
    );
    const base = receives(spans).filter(
      (s) => s.attributes["voice.pipecat.recv.source"] !== "background_loop",
    );
    expect(base.length).toBeGreaterThanOrEqual(1);
    expect(bg).toHaveLength(0);
  });

  // P-regression — a callback firing between turns emits no background span
  it("emits no background span for a frame delivered outside a turn", async () => {
    const ref: { ws?: FakeWebSocket } = {};
    const adapter = makeAdapter(ref);
    await adapter.connect();
    ref.ws!.emit("message", inboundMediaFrame("MZtest")); // no turn active
    await adapter.disconnect();

    const bg = receives(exporter.getFinishedSpans()).filter(
      (s) => s.attributes["voice.pipecat.recv.source"] === "background_loop",
    );
    expect(bg).toHaveLength(0);
  });

  // P3 — receive timeout marks the span ERROR
  it("marks voice.audio.receive ERROR on a receive timeout", async () => {
    const ref: { ws?: FakeWebSocket } = {};
    const adapter = makeAdapter(ref);
    (adapter as unknown as { responseTimeout: number }).responseTimeout = 0.05;
    await adapter.connect();
    // Feed no inbound → the first receiveAudio times out.
    await expect(adapter.call(audioInput(tone(0.05)))).rejects.toThrow();
    await adapter.disconnect();

    const recv = receives(exporter.getFinishedSpans())[0];
    expect(recv.status.code).toBe(SpanStatusCode.ERROR);
    expect(recv.attributes["voice.audio.terminated_reason"]).toBe(
      "first_chunk_timeout",
    );
  });
});
