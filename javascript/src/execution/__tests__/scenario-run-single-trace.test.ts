/**
 * Regression guard (#8014-ish voice trace bug): a whole scenario RUN must
 * surface as exactly ONE trace, not one trace per turn.
 *
 * The bug: `newTurn()` minted each "Scenario Turn" span as a parentless root,
 * so OpenTelemetry gave every turn its own traceId. A real 2-turn phone call
 * produced 3 separate traces (turn 1, turn 2, and the STT back-fill). The fix
 * introduces a run-level "Scenario Run" root that every turn span hangs from.
 *
 * A single-turn scenario could not have caught this (one turn = one trace
 * either way), so this drives a MULTI-turn run through the real execution path
 * with an in-memory span exporter and asserts one traceId across all spans.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  AgentRole,
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { ScenarioExecution } from "../scenario-execution";

class MockAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "assistant" as const, content: "agent reply" };
  }
}

class MockUserSim extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  calls = 0;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    this.calls += 1;
    return `user turn ${this.calls}`;
  }
}

describe("a scenario run is a single trace", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      // Multiple @opentelemetry/sdk-trace-base copies coexist in the tree, so
      // cast to the type this provider's constructor expects (see sibling
      // tests for the same note).
      spanProcessors: [
        new SimpleSpanProcessor(exporter),
      ] as unknown as NonNullable<
        ConstructorParameters<typeof NodeTracerProvider>[0]
      >["spanProcessors"],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  describe("when the run spans multiple turns", () => {
    it("puts every span on one traceId, with turn spans as children of the run root", async () => {
      const sim = new MockUserSim();
      const execution = new ScenarioExecution(
        {
          name: "single-trace multi-turn",
          description: "whole call is one trace",
          agents: [new MockAgent(), sim],
        },
        [
          async (_state, executor) => {
            await executor.proceed(3);
          },
        ],
        "test-batch-id",
      );

      await execution.execute();

      const allSpans = exporter.getFinishedSpans();
      expect(allSpans.length).toBeGreaterThan(0);

      // 1) Exactly one distinct traceId across the WHOLE run.
      const traceIds = new Set(
        allSpans.map((s) => s.spanContext().traceId),
      );
      expect(traceIds.size).toBe(1);

      // 2) Prove it really was multi-turn — otherwise the assertion above is
      //    vacuously true for a single-turn run.
      const turnSpans = allSpans.filter((s) => s.name === "Scenario Turn");
      expect(turnSpans.length).toBeGreaterThanOrEqual(2);
      expect(sim.calls).toBeGreaterThanOrEqual(2);

      // 3) Each turn span is a CHILD of the single run root, not a root.
      const runRoots = allSpans.filter((s) => s.name === "Scenario Run");
      expect(runRoots.length).toBe(1);
      const runRootSpanId = runRoots[0].spanContext().spanId;
      for (const turn of turnSpans) {
        expect(turn.parentSpanContext?.spanId).toBe(runRootSpanId);
      }
    });
  });
});
