/**
 * Span-instrumentation tests for the base voice runtime (#770 / #771).
 *
 * Mic-free: an InMemorySpanExporter captures the spans the REAL production
 * `defaultVoiceCall` / `drainAgentResponse` emit; only the vendor transport
 * (`receiveAudio`/`sendAudio`) is faked. Mirrors the Python
 * `test_voice_spans.py` A1/A3/A4/A5/A6/A7.
 *
 * H2 note: TS has no typed timeout, so a first-chunk timeout and a first-chunk
 * transport error are indistinguishable at the drain — `voice.audio.receive`
 * labels a first-chunk error `first_chunk_timeout` best-effort. The A4-negative
 * (non-timeout first error NOT labelled) is Python-only.
 */
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Register a context manager ONCE so context.with propagates across awaits — our
// runtime reads currentSpan() after `await drainAgentResponse`. Without it,
// context.active() is always root and currentSpan() is undefined.
const _ctxManager = new AsyncLocalStorageContextManager();
_ctxManager.enable();
context.setGlobalContextManager(_ctxManager);

import { AgentRole, type AgentInput } from "../../domain/agents";
import { VoiceAgentAdapter } from "../adapter";
import { AudioChunk, silentChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { createAudioMessage } from "../messages";

const SR = 24000; // PCM16 mono 24kHz

function tone(seconds: number, transcript = "agent"): AudioChunk {
  const data = new Uint8Array(Math.round(seconds * SR) * 2);
  for (let i = 0; i < data.length; i++) data[i] = (i % 250) + 1;
  return new AudioChunk({ data, transcript });
}

type RecvAction = AudioChunk | "throw" | "empty";

class ScriptedAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: false,
    nativeVad: true,
    dtmf: false,
    interruption: false,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });
  lastAgentTranscript: string | null = "agent"; // set → awaitAgentTranscript short-circuits
  sent: AudioChunk[] = [];
  private actions: RecvAction[];

  constructor(actions: RecvAction[]) {
    super();
    this.actions = [...actions];
  }
  override isConnected(): boolean {
    return true;
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(chunk: AudioChunk): Promise<void> {
    this.sent.push(chunk);
  }
  async receiveAudio(_timeout: number): Promise<AudioChunk> {
    const a = this.actions.shift();
    if (a === undefined || a === "empty") return silentChunk(0);
    if (a === "throw") throw new Error("recv failed");
    return a;
  }
}

function audioInput(incoming?: AudioChunk): AgentInput {
  const newMessages = incoming ? [createAudioMessage(incoming, "user")] : [];
  return { newMessages } as unknown as AgentInput;
}

function byName(spans: ReadableSpan[]): Record<string, ReadableSpan> {
  return Object.fromEntries(spans.map((s) => [s.name, s]));
}

describe("voice.* span instrumentation (base runtime)", () => {
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

  // A1
  it("emits voice.-named spans from a real call()", async () => {
    await new ScriptedAdapter([tone(0.1), "throw"]).call(audioInput(tone(0.05)));
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names.some((n) => n.startsWith("voice."))).toBe(true);
    expect(names).toEqual(
      expect.arrayContaining(["voice.turn", "voice.audio.send", "voice.audio.receive"]),
    );
  });

  // A3
  it.each([
    [["throw"] as RecvAction[], "first_chunk_timeout", true],
    [[tone(0.1), "throw"] as RecvAction[], "tail_silence", false],
    [[tone(0.1), "empty"] as RecvAction[], "terminal_chunk", false],
  ])("labels terminated_reason=%s#1", async (actions, reason, throws) => {
    const run = new ScriptedAdapter(actions).call(audioInput(tone(0.05)));
    if (throws) await expect(run).rejects.toThrow();
    else await run;
    const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
    expect(recv.attributes["voice.audio.terminated_reason"]).toBe(reason);
  });

  it("labels max/hard-ceiling as hard_ceiling in TS + sets first_chunk_latency_ms", async () => {
    const big = tone(20); // 20s each; two crosses the 30s*2 hard ceiling? use several
    await new ScriptedAdapter([big, big, big, big]).call(audioInput(tone(0.05)));
    const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
    expect(recv.attributes["voice.audio.terminated_reason"]).toBe("hard_ceiling");
    expect(recv.attributes["voice.audio.first_chunk_latency_ms"]).toBeTypeOf("number");
    expect(recv.attributes["voice.audio.chunk_count"]).toBeGreaterThanOrEqual(1);
  });

  // A4 (positive; H2 note above — negative is Python-only)
  it("marks voice.audio.receive ERROR + first_chunk_timeout on a first-chunk failure", async () => {
    await expect(
      new ScriptedAdapter(["throw"]).call(audioInput(tone(0.05))),
    ).rejects.toThrow();
    const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
    expect(recv.status.code).toBe(SpanStatusCode.ERROR);
    expect(recv.attributes["voice.audio.terminated_reason"]).toBe("first_chunk_timeout");
  });

  // A5 — turn index from scenario state (guards a field rename)
  it("reads voice.turn.index from scenarioState.currentTurn", async () => {
    const input = {
      newMessages: [createAudioMessage(tone(0.05), "user")],
      scenarioState: { currentTurn: 3 },
    } as unknown as AgentInput;
    await new ScriptedAdapter([tone(0.1), "throw"]).call(input);
    const turn = byName(exporter.getFinishedSpans())["voice.turn"];
    expect(turn.attributes["voice.turn.index"]).toBe(3);
  });

  // A5
  it("nests send/receive under voice.turn and carries turn attrs", async () => {
    await new ScriptedAdapter([tone(0.1), "throw"]).call(audioInput(tone(0.05)));
    const spans = byName(exporter.getFinishedSpans());
    const turn = spans["voice.turn"];
    expect(turn.attributes["voice.adapter.class"]).toBe("ScriptedAdapter");
    expect(turn.attributes["voice.turn.latency_ms"]).toBeTypeOf("number");
    expect(spans["voice.audio.send"].parentSpanId).toBe(turn.spanContext().spanId);
    expect(spans["voice.audio.receive"].parentSpanId).toBe(turn.spanContext().spanId);
  });

  // A6
  it("emits voice.audio.send with bytes; a no-incoming turn emits none", async () => {
    const incoming = tone(0.05);
    await new ScriptedAdapter([tone(0.1), "throw"]).call(audioInput(incoming));
    const send = byName(exporter.getFinishedSpans())["voice.audio.send"];
    expect(send.attributes["voice.audio.bytes"]).toBe(incoming.data.length);

    exporter.reset();
    await new ScriptedAdapter([tone(0.1), "throw"]).call(audioInput()); // no incoming
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).not.toContain("voice.audio.send");
    expect(names).toContain("voice.turn");
  });

  // A7 — SAFETY (load-bearing): a telemetry-processor failure must not break a turn.
  it("does not let a processor onEnd failure break the turn", async () => {
    class BoomProcessor implements SpanProcessor {
      forceFlush() { return Promise.resolve(); }
      onStart() {}
      onEnd() { throw new Error("simulated export failure"); }
      shutdown() { return Promise.resolve(); }
    }
    await provider.shutdown();
    provider = new NodeTracerProvider({ spanProcessors: [new BoomProcessor()] });
    trace.setGlobalTracerProvider(provider);

    // A processor whose onEnd throws does NOT break the turn — call() resolves.
    // (OTel JS Span.end() already guards processor.onEnd internally, so the run is
    // safe via the SDK here; our voiceSpan guard is defense-in-depth and ALSO
    // guards the raw-throw path Python's use_span leaves open — proven in the
    // Python A7, where span.end() genuinely propagates and the guard WARNs.)
    const result = await new ScriptedAdapter([tone(0.1), "throw"]).call(
      audioInput(tone(0.05)),
    );
    expect(result).toBeTruthy();
  });
});
