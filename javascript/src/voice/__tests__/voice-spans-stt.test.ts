/**
 * STT span tests (#776) — the per-run back-fill path.
 *
 * Python transcribes PER-TURN inside call() (`_ensure_transcript`), so its
 * `voice.stt.transcribe` span nests under `voice.turn`. TypeScript has NO
 * per-turn STT: `runVoiceTurn` attaches the adapter's NATIVE transcript (not
 * STT), and the actual STT-provider run is a PER-RUN back-fill
 * (`backfillSegmentTranscripts`) in `execute()`'s `finally`, over the recording
 * segments, OUTSIDE any turn span. Per the #776 decision this emits
 * `voice.stt.transcribe` (scope=run) nested under a `voice.stt.backfill` batch
 * span (the batch parent groups the otherwise-orphaned per-run spans, carries
 * the run-correlation attrs, and encodes "per-run, not per-turn" in the shape).
 *
 * Mic-free / offline: drives the REAL `ScenarioExecution.execute()` (the same
 * path `scenario.run()` takes) with a fake voice adapter, a fake STT provider,
 * and a fake judge. No network, no real keys.
 */
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Register a context manager ONCE so context.with propagates across awaits — the
// back-fill children read context.active() (the batch span) after an await.
const _ctxManager = new AsyncLocalStorageContextManager();
_ctxManager.enable();
context.setGlobalContextManager(_ctxManager);

import { type AgentInput, JudgeAgentAdapter } from "../../domain";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { agent, judge, user } from "../../script";
import { AudioChunk } from "../audio-chunk";
import type { STTProvider } from "../stt";
import { AudioUserSimulator } from "./fixtures/audio-user-simulator";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";

const SR = 24000; // PCM16 mono 24kHz

/** Non-silent PCM16 chunk carrying an optional transcript. */
function tone(seconds: number, transcript?: string): AudioChunk {
  const data = new Uint8Array(Math.round(seconds * SR) * 2);
  for (let i = 0; i < data.length; i++) data[i] = (i % 250) + 1;
  return new AudioChunk({ data, transcript });
}

/** In-process STT stub: returns a fixed text, or throws when `boom` is set. */
class FakeSTT implements STTProvider {
  calls = 0;
  constructor(private opts: { text?: string; boom?: Error } = {}) {}
  async transcribe(_audio: AudioChunk): Promise<string> {
    this.calls++;
    if (this.opts.boom) throw this.opts.boom;
    return this.opts.text ?? "transcribed text";
  }
}

/** Fake judge that concludes the run successfully on the judge() step. */
class PassingJudge extends JudgeAgentAdapter {
  criteria: string[] = ["Agent responds"];
  async call(input: AgentInput) {
    if (!input.judgmentRequest) return null;
    return {
      success: true,
      reasoning: "voice turn completed",
      metCriteria: [...this.criteria],
      unmetCriteria: [],
    };
  }
}

/**
 * A voice run needs an AUDIO user turn (the framework fail-closes on a text-only
 * user against a voice agent). The user chunk controls whether the USER segment
 * is a back-fill target: a chunk WITH a transcript → the user segment carries it
 * → NOT a target (default here); a transcript-LESS chunk → a target. The agent
 * reply's transcript (or absence) controls the agent segment the same way.
 */
function buildExecution(
  stt: STTProvider,
  agentReply: AudioChunk,
  userChunk: AudioChunk = tone(0.12, "I need help with my account"),
): ScenarioExecution {
  const adapter = new FakeVoiceAdapter({ responses: [agentReply] });
  return new ScenarioExecution(
    {
      name: "voice / stt back-fill spans",
      description: "#776 per-run STT back-fill spans",
      agents: [adapter, new AudioUserSimulator(userChunk), new PassingJudge()],
      voice: { stt },
    },
    [user(), agent(), judge()],
    "test-batch-id",
  );
}

function byName(spans: ReadableSpan[]): Record<string, ReadableSpan> {
  return Object.fromEntries(spans.map((s) => [s.name, s]));
}

describe("voice.stt.* back-fill spans (#776)", () => {
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

  it("emits voice.stt.transcribe (scope=run) nested under voice.stt.backfill", async () => {
    const stt = new FakeSTT({ text: "the agent said this" });
    // Agent reply is AUDIO-ONLY (no transcript, no lastAgentTranscript) → its
    // recording segment is a back-fill target; the text user makes no segment.
    await buildExecution(stt, tone(0.2)).execute();
    const spans = byName(exporter.getFinishedSpans());

    expect(spans["voice.stt.backfill"]).toBeDefined();
    expect(spans["voice.stt.transcribe"]).toBeDefined();

    const t = spans["voice.stt.transcribe"];
    expect(t.attributes["voice.stt.scope"]).toBe("run");
    expect(t.attributes["voice.stt.speaker"]).toBe("agent");
    expect(t.attributes["voice.stt.audio_bytes"]).toBeGreaterThan(0);
    expect(t.attributes["voice.stt.transcript_chars"]).toBe(
      "the agent said this".length,
    );
    expect(t.attributes["langwatch.span.type"]).toBe("span");
    // The per-run position: nested under the batch span, NOT under a turn span.
    expect(t.parentSpanContext?.spanId).toBe(
      spans["voice.stt.backfill"].spanContext().spanId,
    );

    // The batch span carries segment_count AND the run-correlation attrs, so the
    // otherwise-orphan per-run trace is attributable to the run (#776 review).
    const backfill = spans["voice.stt.backfill"];
    expect(backfill.attributes["voice.stt.segment_count"]).toBe(1);
    expect(backfill.attributes["voice.stt.scope"]).toBe("run");
    expect(backfill.attributes["langwatch.origin"]).toBe("simulation");
    expect(backfill.attributes["scenario.run_id"]).toBeTruthy();
    expect(stt.calls).toBe(1);
  });

  it("labels each segment's speaker and scales segment_count (user + agent targets)", async () => {
    const stt = new FakeSTT({ text: "text" });
    // Transcript-LESS user chunk → BOTH the user and the agent segment are
    // targets → two children with distinct speakers under one batch span.
    await buildExecution(stt, tone(0.2), tone(0.12)).execute();
    const finished = exporter.getFinishedSpans();
    const transcribes = finished.filter((s) => s.name === "voice.stt.transcribe");
    const backfill = byName(finished)["voice.stt.backfill"];

    expect(transcribes.length).toBe(2);
    expect(backfill.attributes["voice.stt.segment_count"]).toBe(2);
    const speakers = transcribes
      .map((s) => s.attributes["voice.stt.speaker"])
      .sort();
    expect(speakers).toEqual(["agent", "user"]);
    // both children parent under the single batch span
    for (const t of transcribes) {
      expect(t.parentSpanContext?.spanId).toBe(backfill.spanContext().spanId);
    }
    expect(stt.calls).toBe(2);
  });

  it("marks voice.stt.transcribe ERROR on provider failure but the run still completes, without leaking the raw provider message", async () => {
    // A provider error whose message embeds a secret-shaped body (the exact
    // OpenAI/ElevenLabs leak the sanitization guards against).
    const stt = new FakeSTT({
      boom: new Error("401 Unauthorized: invalid key sk-abc...wxyz body={...}"),
    });
    const result = await buildExecution(stt, tone(0.2)).execute();
    expect(result).toBeTruthy(); // run completed despite the STT failure

    const spans = byName(exporter.getFinishedSpans());
    const t = spans["voice.stt.transcribe"];
    expect(t.status.code).toBe(SpanStatusCode.ERROR);
    expect(t.attributes["voice.stt.transcript_chars"]).toBeUndefined();
    // The batch span itself is NOT errored — per-segment failures are swallowed
    // inside it (best-effort), so a batch of otherwise-fine segments succeeds.
    expect(spans["voice.stt.backfill"].status.code).not.toBe(
      SpanStatusCode.ERROR,
    );
    // SECURITY (#776 review): the raw provider message must NOT reach the
    // exported span — the recorded exception is sanitized to a provider-agnostic
    // string, so no response body / key fragment leaks into telemetry.
    const recorded = JSON.stringify(t.events);
    expect(recorded).not.toContain("sk-abc");
    expect(recorded).not.toContain("401 Unauthorized");
    expect(recorded).toContain("STT provider failed");
  });

  it("emits a span with no transcript_chars (OK, not ERROR) when STT returns empty text", async () => {
    const stt = new FakeSTT({ text: "" }); // no-speech / silence result
    await buildExecution(stt, tone(0.2)).execute();
    const t = byName(exporter.getFinishedSpans())["voice.stt.transcribe"];
    expect(t).toBeDefined();
    expect(t.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(t.attributes["voice.stt.transcript_chars"]).toBeUndefined();
    expect(t.attributes["voice.stt.audio_bytes"]).toBeGreaterThan(0);
  });

  it("emits no voice.stt.* spans when every segment already has a transcript", async () => {
    const stt = new FakeSTT();
    // Agent reply carries its own transcript → no segment is a back-fill target.
    await buildExecution(stt, tone(0.2, "already have it")).execute();
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).not.toContain("voice.stt.transcribe");
    expect(names).not.toContain("voice.stt.backfill");
    expect(stt.calls).toBe(0);
  });
});
