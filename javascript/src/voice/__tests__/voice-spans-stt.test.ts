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
 * span (the batch parent groups the otherwise-orphaned per-run spans and encodes
 * "per-run, not per-turn" in the trace shape).
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

import {
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  JudgeAgentAdapter,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { agent, judge, user } from "../../script";
import { AudioChunk } from "../audio-chunk";
import { createAudioMessage } from "../messages";
import type { STTProvider } from "../stt";
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
  constructor(private opts: { text?: string; boom?: boolean } = {}) {}
  async transcribe(_audio: AudioChunk): Promise<string> {
    this.calls++;
    if (this.opts.boom) throw new Error("stt down");
    return this.opts.text ?? "transcribed text";
  }
}

/** User simulator that emits an AUDIO message so the agent records a user turn. */
class AudioUserSimulator extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  constructor(private userTranscript?: string) {
    super();
  }
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return createAudioMessage(
      tone(0.12, this.userTranscript),
      "user",
    ) as unknown as AgentReturnTypes;
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

function buildExecution(
  stt: STTProvider,
  agentReply: AudioChunk,
  transcriptlessUser = false,
): ScenarioExecution {
  // Default: the user audio carries a transcript, so ONLY the agent reply is a
  // back-fill target. `transcriptlessUser` drops it so the user segment is a
  // target too (used to prove voice.stt.speaker + segment_count scale).
  const userTranscript = transcriptlessUser
    ? undefined
    : "I need help with my account";
  const adapter = new FakeVoiceAdapter({ responses: [agentReply] });
  return new ScenarioExecution(
    {
      name: "voice / stt back-fill spans",
      description: "#776 per-run STT back-fill spans",
      agents: [adapter, new AudioUserSimulator(userTranscript), new PassingJudge()],
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
    // recording segment is a back-fill target; the user segment already carries
    // its transcript so it is not.
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
    expect(t.parentSpanId).toBe(
      spans["voice.stt.backfill"].spanContext().spanId,
    );
    expect(
      spans["voice.stt.backfill"].attributes["voice.stt.segment_count"],
    ).toBe(1);
    expect(spans["voice.stt.backfill"].attributes["voice.stt.scope"]).toBe(
      "run",
    );
    expect(stt.calls).toBe(1);
  });

  it("labels each segment's speaker and scales segment_count (user + agent targets)", async () => {
    const stt = new FakeSTT({ text: "text" });
    // BOTH the user audio (no transcript) and the agent reply (no transcript)
    // are back-fill targets → two voice.stt.transcribe children with distinct
    // speakers under one batch span. Proves voice.stt.speaker flows from
    // seg.speaker (not a hardcoded constant) and segment_count reflects N.
    await buildExecution(stt, tone(0.2), true).execute();
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
      expect(t.parentSpanId).toBe(backfill.spanContext().spanId);
    }
    expect(stt.calls).toBe(2);
  });

  it("marks voice.stt.transcribe ERROR on provider failure but the run still completes", async () => {
    const stt = new FakeSTT({ boom: true });
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
