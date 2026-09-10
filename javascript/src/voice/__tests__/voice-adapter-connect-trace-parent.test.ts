/**
 * Regression guard: `startVoiceAdapters()` runs before the first script step,
 * with no active OTel context unless `execute()` deliberately parents it under
 * the turn-1 `Scenario Turn` span. Without that parenting, `voice.adapter.connect`
 * / `voice.adapter.dial` become roots of their OWN trace — a real run then shows
 * the call's dial metadata in a trace the platform never links to the run
 * (the platform links a run to the traces its messages carry).
 *
 * Drives the real `ScenarioExecution.execute()` with a fake voice adapter and
 * an in-memory span exporter, reusing the `voice-spans-stt.test.ts` fixtures.
 */
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const _ctxManager = new AsyncLocalStorageContextManager();
_ctxManager.enable();
context.setGlobalContextManager(_ctxManager);

import { type AgentInput, JudgeAgentAdapter } from "../../domain";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { agent, judge, user } from "../../script";
import { AudioUserSimulator } from "./fixtures/audio-user-simulator";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";
import { AudioChunk } from "../audio-chunk";

const SR = 24000;
function tone(seconds: number, transcript?: string): AudioChunk {
  const data = new Uint8Array(Math.round(seconds * SR) * 2);
  for (let i = 0; i < data.length; i++) data[i] = (i % 250) + 1;
  return new AudioChunk({ data, transcript });
}

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

describe("voice.adapter.connect trace parenting", () => {
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

  it("nests voice.adapter.connect under the turn-1 Scenario Turn span, not a separate trace", async () => {
    const adapter = new FakeVoiceAdapter({ responses: [tone(0.2)] });
    const execution = new ScenarioExecution(
      {
        name: "voice / connect trace parenting",
        description: "voice.adapter.connect must share the run's trace",
        agents: [
          adapter,
          new AudioUserSimulator(tone(0.12, "hello")),
          new PassingJudge(),
        ],
      },
      [user(), agent(), judge()],
      "test-batch-id",
    );

    await execution.execute();

    const spans = exporter.getFinishedSpans();
    const turnSpan = spans.find((s) => s.name === "Scenario Turn");
    const connectSpan = spans.find((s) => s.name === "voice.adapter.connect");

    expect(turnSpan).toBeDefined();
    expect(connectSpan).toBeDefined();
    expect(connectSpan!.spanContext().traceId).toBe(
      turnSpan!.spanContext().traceId,
    );
    expect(connectSpan!.parentSpanContext?.spanId).toBe(
      turnSpan!.spanContext().spanId,
    );
  });
});
