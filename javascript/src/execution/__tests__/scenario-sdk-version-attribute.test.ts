import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pkg from "../../../package.json";
import {
  AgentRole,
  AgentAdapter,
  JudgeAgentAdapter,
  AgentInput,
  AgentReturnTypes,
} from "../../domain";
import { UserSimulatorAgentAdapter } from "../../domain/agents";
import { user, agent, judge, proceed } from "../../script";
import { ScenarioExecution } from "../scenario-execution";

class MockAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "assistant" as const, content: "Hey, how can I help you?" };
  }
}

class MockUserSimulatorAgent extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "Hi, I'm a user";
  }
}

class MockJudgeAgent extends JudgeAgentAdapter {
  criteria = ["test criterion passes"];
  async call(input: AgentInput) {
    if (!input.judgmentRequest) return null;
    return {
      success: true,
      reasoning: "All criteria passed",
      metCriteria: input.judgmentRequest.criteria ?? [],
      unmetCriteria: [],
    };
  }
}

describe("scenario.sdk.* attributes (#733)", () => {
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

  describe("when a scenario turn starts", () => {
    it("stamps scenario.sdk.name and scenario.sdk.version on the turn span", async () => {
      const execution = new ScenarioExecution(
        {
          name: "sdk version test",
          description: "test scenario.sdk.* attributes",
          agents: [
            new MockAgent(),
            new MockUserSimulatorAgent(),
            new MockJudgeAgent(),
          ],
        },
        [
          user("hello"),
          agent(),
          judge({ criteria: ["test criterion passes"] }),
        ],
        "test-batch-id"
      );

      await execution.execute();

      const spans = exporter.getFinishedSpans();
      const turnSpans = spans.filter((s) => s.name === "Scenario Turn");
      expect(turnSpans.length).toBeGreaterThan(0);

      for (const span of turnSpans) {
        expect(span.attributes).toHaveProperty(
          ["scenario.sdk.name"],
          pkg.name
        );
        expect(span.attributes).toHaveProperty(
          ["scenario.sdk.version"],
          pkg.version
        );
      }
    });

    it("emits a non-empty, semver-shaped version value on the span", async () => {
      const execution = new ScenarioExecution(
        {
          name: "sdk version shape test",
          description: "emitted version is a real semver string",
          agents: [
            new MockAgent(),
            new MockUserSimulatorAgent(),
            new MockJudgeAgent(),
          ],
        },
        [
          user("hello"),
          agent(),
          judge({ criteria: ["test criterion passes"] }),
        ],
        "test-batch-id"
      );

      await execution.execute();

      const turnSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === "Scenario Turn");
      expect(turnSpans.length).toBeGreaterThan(0);

      // Assert the *emitted* value directly (not compared back to package.json):
      // it must be a non-empty, semver-shaped string, proving a real version
      // was resolved rather than an empty/undefined placeholder.
      const emittedVersion = turnSpans[0]?.attributes["scenario.sdk.version"];
      expect(typeof emittedVersion).toBe("string");
      expect(emittedVersion as string).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe("when a scenario runs multiple turns", () => {
    it("stamps scenario.sdk.* on every turn span", async () => {
      let judgeCallCount = 0;

      class MultiTurnJudge extends JudgeAgentAdapter {
        criteria = ["test"];
        async call(input: AgentInput) {
          if (!input.judgmentRequest) return null;
          judgeCallCount++;
          if (judgeCallCount >= 2) {
            return {
              success: true,
              reasoning: "done",
              metCriteria: ["test"],
              unmetCriteria: [],
            };
          }
          return null;
        }
      }

      const execution = new ScenarioExecution(
        {
          name: "multi-turn sdk version test",
          description: "scenario.sdk.* persists across turns",
          agents: [
            new MockAgent(),
            new MockUserSimulatorAgent(),
            new MultiTurnJudge(),
          ],
        },
        [proceed()],
        "test-batch-id"
      );

      await execution.execute();

      const turnSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === "Scenario Turn");
      expect(turnSpans.length).toBeGreaterThanOrEqual(2);

      for (const span of turnSpans) {
        expect(span.attributes).toHaveProperty(
          ["scenario.sdk.name"],
          pkg.name
        );
        expect(span.attributes).toHaveProperty(
          ["scenario.sdk.version"],
          pkg.version
        );
      }
    });
  });
});
