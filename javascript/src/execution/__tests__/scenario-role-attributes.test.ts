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
import { user, agent, judge } from "../../script";
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

function agentCallSpans(exporter: InMemorySpanExporter) {
  return exporter.getFinishedSpans().filter((s) => s.name.endsWith(".call"));
}

describe("scenario.role attribute", () => {
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

  describe("when a scenario executes a user agent", () => {
    it("sets scenario.role to 'User' on the user agent span", async () => {
      const execution = new ScenarioExecution(
        {
          name: "role test",
          description: "test role attribute",
          agents: [
            new MockAgent(),
            new MockUserSimulatorAgent(),
            new MockJudgeAgent(),
          ],
        },
        [
          user(),
          agent(),
          judge({ criteria: ["test criterion passes"] }),
        ],
        "test-batch-id"
      );

      await execution.execute();

      const spans = agentCallSpans(exporter);
      const userSpans = spans.filter(
        (s) => s.name === "MockUserSimulatorAgent.call"
      );
      expect(userSpans.length).toBeGreaterThan(0);

      for (const span of userSpans) {
        expect(span.attributes).toHaveProperty(
          "scenario.role",
          "User"
        );
      }
    });
  });

  describe("when a scenario executes the agent under test", () => {
    it("sets scenario.role to 'Agent' on the agent span", async () => {
      const execution = new ScenarioExecution(
        {
          name: "role test",
          description: "test role attribute",
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

      const spans = agentCallSpans(exporter);
      const agentSpans = spans.filter((s) => s.name === "MockAgent.call");
      expect(agentSpans.length).toBeGreaterThan(0);

      for (const span of agentSpans) {
        expect(span.attributes).toHaveProperty(
          "scenario.role",
          "Agent"
        );
      }
    });
  });

  describe("when a scenario executes the judge agent", () => {
    it("sets scenario.role to 'Judge' on the judge span", async () => {
      const execution = new ScenarioExecution(
        {
          name: "role test",
          description: "test role attribute",
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

      const spans = agentCallSpans(exporter);
      const judgeSpans = spans.filter(
        (s) => s.name === "MockJudgeAgent.call"
      );
      expect(judgeSpans.length).toBeGreaterThan(0);

      for (const span of judgeSpans) {
        expect(span.attributes).toHaveProperty(
          "scenario.role",
          "Judge"
        );
      }
    });
  });
});

describe("scenario.run_id attribute", () => {
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

  describe("when a scenario executes", () => {
    it("sets scenario.run_id on the root Scenario Turn span", async () => {
      const execution = new ScenarioExecution(
        {
          name: "run_id test",
          description: "test run_id attribute",
          agents: [
            new MockAgent(),
            new MockUserSimulatorAgent(),
            new MockJudgeAgent(),
          ],
        },
        [
          user(),
          agent(),
          judge({ criteria: ["test criterion passes"] }),
        ],
        "test-batch-id"
      );

      await execution.execute();

      const allSpans = exporter.getFinishedSpans();
      const rootSpans = allSpans.filter((s) => s.name === "Scenario Turn");
      expect(rootSpans.length).toBeGreaterThan(0);

      for (const span of rootSpans) {
        const runId = span.attributes["scenario.run_id"];
        expect(runId).toBeDefined();
        expect(typeof runId).toBe("string");
        expect((runId as string).length).toBeGreaterThan(0);
      }
    });

    it("does not set scenario.run_id on agent call spans", async () => {
      const execution = new ScenarioExecution(
        {
          name: "run_id placement test",
          description: "test run_id only on root",
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

      const spans = agentCallSpans(exporter);
      for (const span of spans) {
        expect(span.attributes["scenario.run_id"]).toBeUndefined();
      }
    });
  });
});

