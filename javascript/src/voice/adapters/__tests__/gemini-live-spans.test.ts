/**
 * Span-instrumentation tests for GeminiLiveAgentAdapter (#770 / #772, PR2).
 *
 * Mic-free: an InMemorySpanExporter captures the spans the REAL production
 * `defaultVoiceCall` / `drainAgentResponse` emit, plus the `voice.gemini.*`
 * attributes the adapter stamps onto them; only the `@google/genai` SDK is
 * mocked (via `vi.mock`), and server messages are injected by calling the
 * captured `onmessage` callback. Combines the harness from
 * `voice/__tests__/voice-spans.test.ts` (AsyncLocalStorage context bootstrap +
 * per-test provider) with the fake-session pattern from
 * `adapters/__tests__/gemini-live.test.ts`.
 *
 * Mirrors the Python `test_voice_spans_gemini.py` ACs that apply to TS:
 * AC1, AC3, AC4, AC6, AC7, AC8, plus a parity check (AC10). AC2/AC5/AC9 are
 * either py-executor-loop-shaped or py-only (typed timeout / FirstChunkTimeout
 * cause); the TS-relevant surface is covered here + by voice-spans.test.ts.
 *
 * H2 note (see voice-spans.test.ts): TS has no typed timeout, so a first-chunk
 * transport error (go_away) is best-effort labelled `first_chunk_timeout` — AC6
 * asserts ERROR + propagation rather than the py `!= first_chunk_timeout`.
 */

import { Buffer } from "node:buffer";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

// Register a context manager ONCE so context.with propagates across awaits — the
// runtime + adapter read currentSpan() after awaits. Without it context.active()
// is always root and currentSpan() is undefined. (Mirrors voice-spans.test.ts.)
const _ctxManager = new AsyncLocalStorageContextManager();
_ctxManager.enable();
context.setGlobalContextManager(_ctxManager);

// --------------------------------------------------------------------------
// Mock @google/genai — capture the connect params (onmessage + the FakeSession)
// so tests can inject server messages and inspect the wire sends. The factory
// runs lazily at connect() time (dynamic import), after `captured` is defined.
// --------------------------------------------------------------------------

type FakeSessionHandle = {
  sendRealtimeInput: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

interface CapturedConnect {
  model?: string;
  config?: Record<string, unknown>;
  onmessage?: (msg: unknown) => void;
  session?: FakeSessionHandle;
}

const captured: { last: CapturedConnect | null } = { last: null };

vi.mock("@google/genai", () => {
  class FakeSession {
    sendRealtimeInput = vi.fn();
    close = vi.fn();
  }
  return {
    Modality: { AUDIO: "AUDIO" },
    GoogleGenAI: class {
      live = {
        connect: async (params: {
          model: string;
          config: Record<string, unknown>;
          callbacks?: { onmessage?: (msg: unknown) => void };
        }) => {
          const session = new FakeSession();
          captured.last = {
            model: params.model,
            config: params.config,
            onmessage: params.callbacks?.onmessage,
            session,
          };
          return session;
        },
      };
      constructor(_init: { apiKey?: string }) {}
    },
  };
});

import { GeminiLiveAgentAdapter } from "../gemini-live";
import { AudioChunk } from "../../audio-chunk";
import { createAudioMessage } from "../../messages";
import { voiceSpan } from "../../telemetry";
import type { AgentInput } from "../../../domain/agents";

// 2400 samples @24kHz → 1600 samples @16kHz → 3200 bytes after the wire resample.
const USER_BYTES = 4800;
const WIRE_BYTES = 3200;

function tone(nBytes: number): AudioChunk {
  const data = new Uint8Array(nBytes);
  for (let i = 0; i < data.length; i++) data[i] = (i % 250) + 1;
  return new AudioChunk({ data });
}

function audioB64(): string {
  // 4 bytes: two int16 zero samples, little-endian — survives the PCM16 invariant.
  return Buffer.from(new Uint8Array([0, 0, 0, 0])).toString("base64");
}

function audioInput(incoming?: AudioChunk): AgentInput {
  const newMessages = incoming ? [createAudioMessage(incoming, "user")] : [];
  return { newMessages } as unknown as AgentInput;
}

function byName(spans: ReadableSpan[]): Record<string, ReadableSpan> {
  return Object.fromEntries(spans.map((s) => [s.name, s]));
}

// Server-message shapes receiveAudio reads (camelCase, @google/genai convention).
function audioMsg(): unknown {
  return {
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: audioB64() } }] },
      outputTranscription: { text: "hi" },
    },
  };
}
function turnCompleteMsg(): unknown {
  return { serverContent: { turnComplete: true } };
}
function interruptedMsg(): unknown {
  return { serverContent: { interrupted: true } };
}
function goAwayMsg(): unknown {
  return { goAway: { reason: "server terminate" } };
}

async function connectAdapter(init?: {
  model?: string;
  voice?: string;
}): Promise<{
  adapter: GeminiLiveAgentAdapter;
  onmessage: (msg: unknown) => void;
  session: FakeSessionHandle;
}> {
  const adapter = new GeminiLiveAgentAdapter({ apiKey: "test-key", ...init });
  captured.last = null;
  await adapter.connect();
  const c = captured.last as CapturedConnect | null;
  if (!c?.onmessage || !c.session) {
    throw new Error("connect() did not register onmessage / session");
  }
  return { adapter, onmessage: c.onmessage, session: c.session };
}

describe("voice.gemini.* span instrumentation (GeminiLiveAgentAdapter)", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    captured.last = null;
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

  // AC1
  it("AC1: a real call() emits {voice.turn, voice.audio.send, voice.audio.receive} with the Gemini class; greeting emits no send", async () => {
    const { adapter, onmessage } = await connectAdapter();
    onmessage(audioMsg());
    onmessage(turnCompleteMsg());
    await adapter.call(audioInput(tone(USER_BYTES)));

    const spans = byName(exporter.getFinishedSpans());
    expect(Object.keys(spans)).toEqual(
      expect.arrayContaining([
        "voice.turn",
        "voice.audio.send",
        "voice.audio.receive",
      ]),
    );
    expect(spans["voice.turn"].attributes["voice.adapter.class"]).toBe(
      "GeminiLiveAgentAdapter",
    );

    // A greeting (no incoming audio) emits NO voice.audio.send span.
    exporter.reset();
    onmessage(audioMsg());
    onmessage(turnCompleteMsg());
    await adapter.call(audioInput());
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).not.toContain("voice.audio.send");
    expect(names).toContain("voice.turn");
    await adapter.disconnect();
  });

  // AC3
  it("AC3: voice.audio.send carries voice.gemini.audio.wire_bytes = resampled length; empty resample → 0 + no markers", async () => {
    const { adapter, session } = await connectAdapter();

    // Non-empty: 4800-byte input → 3200-byte resample + 3 wire sends.
    await voiceSpan(
      "voice.audio.send",
      { "voice.audio.bytes": USER_BYTES },
      async () => {
        await adapter.sendAudio(tone(USER_BYTES));
      },
    );
    let send = byName(exporter.getFinishedSpans())["voice.audio.send"];
    expect(send.attributes["voice.gemini.audio.wire_bytes"]).toBe(WIRE_BYTES);
    expect(session.sendRealtimeInput.mock.calls.length).toBe(3);

    // Empty resample: 2-byte input (1 sample) → wire_bytes 0, NO markers.
    exporter.reset();
    session.sendRealtimeInput.mockClear();
    await voiceSpan(
      "voice.audio.send",
      { "voice.audio.bytes": 2 },
      async () => {
        await adapter.sendAudio(tone(2));
      },
    );
    send = byName(exporter.getFinishedSpans())["voice.audio.send"];
    expect(send.attributes["voice.gemini.audio.wire_bytes"]).toBe(0);
    expect(session.sendRealtimeInput.mock.calls.length).toBe(0);
    await adapter.disconnect();
  });

  // AC4
  it("AC4: voice.audio.receive carries spurious_retry_count == K and turn_complete=true (K=0 on a clean turn)", async () => {
    const { adapter, onmessage } = await connectAdapter();

    // K = 0 — a clean turn.
    onmessage(audioMsg());
    onmessage(turnCompleteMsg());
    await adapter.call(audioInput(tone(USER_BYTES)));
    let recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
    expect(recv.attributes["voice.gemini.spurious_retry_count"]).toBe(0);
    expect(recv.attributes["voice.gemini.turn_complete"]).toBe(true);

    // K = 3 — three scripted spurious interrupted→turnComplete pairs then real audio.
    exporter.reset();
    for (let i = 0; i < 3; i++) {
      onmessage(interruptedMsg());
      onmessage(turnCompleteMsg());
    }
    onmessage(audioMsg());
    onmessage(turnCompleteMsg());
    await adapter.call(audioInput(tone(USER_BYTES)));
    recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
    expect(recv.attributes["voice.gemini.spurious_retry_count"]).toBe(3);
    expect(recv.attributes["voice.gemini.turn_complete"]).toBe(true);
    await adapter.disconnect();
  });

  // AC6 (H2 asymmetry — see file header)
  it("AC6: a go_away on the first chunk → voice.audio.receive ERROR and the error propagates", async () => {
    const { adapter, onmessage } = await connectAdapter();
    onmessage(goAwayMsg());
    await expect(adapter.call(audioInput())).rejects.toThrow(/goAway/i);
    const recv = byName(exporter.getFinishedSpans())["voice.audio.receive"];
    expect(recv.status.code).toBe(SpanStatusCode.ERROR);
    await adapter.disconnect();
  });

  // AC7
  it("AC7: interrupt() stamps sentinel_fired when connected, no_op_not_connected when not", async () => {
    const { adapter } = await connectAdapter();
    await voiceSpan(
      "voice.adapter.interrupt",
      { "voice.adapter.class": adapter.constructor.name },
      async () => {
        await adapter.interrupt();
      },
    );
    let span = byName(exporter.getFinishedSpans())["voice.adapter.interrupt"];
    expect(span.attributes["voice.adapter.class"]).toBe("GeminiLiveAgentAdapter");
    expect(span.attributes["voice.gemini.interrupt.outcome"]).toBe("sentinel_fired");
    await adapter.disconnect();

    // Not connected → the no-op branch.
    exporter.reset();
    const adapter2 = new GeminiLiveAgentAdapter({ apiKey: "k" });
    await voiceSpan(
      "voice.adapter.interrupt",
      { "voice.adapter.class": adapter2.constructor.name },
      async () => {
        await adapter2.interrupt();
      },
    );
    span = byName(exporter.getFinishedSpans())["voice.adapter.interrupt"];
    expect(span.attributes["voice.gemini.interrupt.outcome"]).toBe(
      "no_op_not_connected",
    );
  });

  // AC8
  it("AC8: exactly one voice.audio.receive span per turn; total voice.* span count invariant to spurious-retry count", async () => {
    const { adapter, onmessage } = await connectAdapter();

    onmessage(interruptedMsg());
    onmessage(turnCompleteMsg());
    onmessage(audioMsg());
    onmessage(turnCompleteMsg());
    await adapter.call(audioInput(tone(USER_BYTES)));
    let vs = exporter
      .getFinishedSpans()
      .filter((s) => s.name.startsWith("voice."));
    const count1 = vs.length;
    expect(vs.filter((s) => s.name === "voice.audio.receive").length).toBe(1);

    exporter.reset();
    for (let i = 0; i < 3; i++) {
      onmessage(interruptedMsg());
      onmessage(turnCompleteMsg());
    }
    onmessage(audioMsg());
    onmessage(turnCompleteMsg());
    await adapter.call(audioInput(tone(USER_BYTES)));
    vs = exporter.getFinishedSpans().filter((s) => s.name.startsWith("voice."));
    const count3 = vs.length;
    expect(vs.filter((s) => s.name === "voice.audio.receive").length).toBe(1);
    expect(count1).toBe(count3);
    await adapter.disconnect();
  });

  // AC10 — cross-language parity
  it("AC10 (parity): the voice.* span-name set + voice.gemini.* attr keys match the Python taxonomy", async () => {
    // Drive each phase inside the matching executor-owned base span (as the
    // executor loops do in production) so every taxonomy element is emitted.
    const adapter = new GeminiLiveAgentAdapter({ apiKey: "k", voice: "Algieba" });
    captured.last = null;
    await voiceSpan(
      "voice.adapter.connect",
      { "voice.adapter.class": adapter.constructor.name },
      async () => {
        await adapter.connect();
      },
    );
    const c = captured.last as CapturedConnect | null;
    const onmessage = c?.onmessage;
    if (!onmessage) throw new Error("connect() did not register onmessage");
    onmessage(audioMsg());
    onmessage(turnCompleteMsg());
    await adapter.call(audioInput(tone(USER_BYTES)));
    await voiceSpan(
      "voice.adapter.interrupt",
      { "voice.adapter.class": adapter.constructor.name },
      async () => {
        await adapter.interrupt();
      },
    );
    await voiceSpan(
      "voice.adapter.disconnect",
      { "voice.adapter.class": adapter.constructor.name },
      async () => {
        await adapter.disconnect();
      },
    );

    const spans = exporter.getFinishedSpans();
    const spanNames = new Set(
      spans.map((s) => s.name).filter((n) => n.startsWith("voice.")),
    );
    const geminiKeys = new Set<string>();
    for (const s of spans) {
      for (const k of Object.keys(s.attributes)) {
        if (k.startsWith("voice.gemini.")) geminiKeys.add(k);
      }
    }

    expect([...spanNames].sort()).toEqual([
      "voice.adapter.connect",
      "voice.adapter.disconnect",
      "voice.adapter.interrupt",
      "voice.audio.receive",
      "voice.audio.send",
      "voice.turn",
    ]);
    // TS emits every Python voice.gemini.* key EXCEPT interrupt.drained_chunks:
    // Python drains the cancelled turn with a 2s bound (pull iterator) and counts
    // the drained messages; the JS SDK is a passive abort-sentinel (push callback)
    // with no drain, so there is no count to report. Documented asymmetry.
    expect([...geminiKeys].sort()).toEqual([
      "voice.gemini.audio.wire_bytes",
      "voice.gemini.interrupt.outcome",
      "voice.gemini.model",
      "voice.gemini.spurious_retry_count",
      "voice.gemini.turn_complete",
      "voice.gemini.voice",
    ]);
  });
});
