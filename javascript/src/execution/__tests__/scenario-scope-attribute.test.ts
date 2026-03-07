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
  JudgeAgentAdapter,
  AgentInput,
  AgentReturnTypes,
} from "../../domain";
import { user, agent, judge, proceed } from "../../script";
import { ScenarioExecution } from "../scenario-execution";
import { UserSimulatorAgentAdapter } from "../../domain/agents";

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

describe("langwatch.origin attribute", () => {
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
    it("sets langwatch.origin to 'simulation' on the turn span", async () => {
      const execution = new ScenarioExecution(
        {
          name: "scope test",
          description: "test langwatch.origin attribute",
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
          "langwatch.origin",
          "simulation"
        );
      }
    });
  });

  describe("when a scenario runs multiple turns", () => {
    it("sets langwatch.origin to 'simulation' on every turn span", async () => {
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
          name: "multi-turn scope test",
          description: "test langwatch.origin persists",
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

      const spans = exporter.getFinishedSpans();
      const turnSpans = spans.filter((s) => s.name === "Scenario Turn");
      expect(turnSpans.length).toBeGreaterThanOrEqual(2);

      for (const span of turnSpans) {
        expect(span.attributes).toHaveProperty(
          "langwatch.origin",
          "simulation"
        );
      }
    });
  });
});
