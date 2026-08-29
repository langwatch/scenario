// Ref: specs/agent-adapter-names.feature
import { describe, it, expect } from "vitest";
import {
  AgentRole,
  AgentAdapter,
  JudgeAgentAdapter,
  AgentInput,
  AgentReturnTypes,
} from "../../domain";
import { UserSimulatorAgentAdapter } from "../../domain/agents";
import { ScenarioEventType, type ScenarioRunStartedEvent } from "../../events";
import { user, agent, judge } from "../../script";
import { ScenarioExecution } from "../scenario-execution";

class NamedAgent extends AgentAdapter {
  name = "MyAgent";
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "assistant" as const, content: "Hey, how can I help you?" };
  }
}

class PlainAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "assistant" as const, content: "Hey, how can I help you?" };
  }
}

class BlankNameAgent extends AgentAdapter {
  name = "   ";
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "assistant" as const, content: "Hey, how can I help you?" };
  }
}

class PaddedNameAgent extends AgentAdapter {
  name = "  MyAgent  ";
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "assistant" as const, content: "Hey, how can I help you?" };
  }
}

/** The object style that the docs show, written without a name. */
const plainObjectAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "assistant" as const, content: "Hey, how can I help you?" };
  },
};

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

async function runStartedMetadata(
  agentUnderTest: AgentAdapter,
  metadata?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const execution = new ScenarioExecution(
    {
      name: "agents scenario",
      description: "test agents metadata",
      agents: [
        agentUnderTest,
        new MockUserSimulatorAgent(),
        new MockJudgeAgent(),
      ],
      metadata,
    },
    [user("hello"), agent(), judge({ criteria: ["test criterion passes"] })],
    "test-batch-id"
  );

  const events: ScenarioRunStartedEvent[] = [];
  execution.events$.subscribe((event) => {
    if (event.type === ScenarioEventType.RUN_STARTED) {
      events.push(event as ScenarioRunStartedEvent);
    }
  });

  await execution.execute();

  expect(events.length).toBeGreaterThan(0);
  return events[0]!.metadata as Record<string, unknown>;
}

describe("run started agents metadata", () => {
  describe("when an adapter sets an explicit name", () => {
    it("reports that name with the agent role", async () => {
      const metadata = await runStartedMetadata(new NamedAgent());

      expect(metadata.agents).toBeDefined();
      expect((metadata.agents as unknown[])[0]).toEqual({
        name: "MyAgent",
        role: "agent",
      });
    });
  });

  describe("when an adapter sets no name", () => {
    it("reports the class name of the adapter", async () => {
      const metadata = await runStartedMetadata(new PlainAgent());

      expect((metadata.agents as unknown[])[0]).toEqual({
        name: "PlainAgent",
        role: "agent",
      });
    });
  });

  describe("when an adapter sets a name with space around it", () => {
    it("reports the name without that space", async () => {
      const metadata = await runStartedMetadata(new PaddedNameAgent());

      expect((metadata.agents as unknown[])[0]).toEqual({
        name: "MyAgent",
        role: "agent",
      });
    });
  });

  describe("when an adapter sets a blank name", () => {
    it("reports the class name, the way the Python SDK does", async () => {
      const metadata = await runStartedMetadata(new BlankNameAgent());

      expect((metadata.agents as unknown[])[0]).toEqual({
        name: "BlankNameAgent",
        role: "agent",
      });
    });
  });

  describe("when an adapter is a plain object with no name", () => {
    it("leaves it out of the list instead of reporting Object", async () => {
      const metadata = await runStartedMetadata(plainObjectAgent);

      expect(metadata.agents).toEqual([
        { name: "UserSimulatorAgent", role: "user" },
        { name: "JudgeAgent", role: "judge" },
      ]);
    });
  });

  describe("when the scenario lists a user simulator and a judge", () => {
    it("reports every role in the order of the agents list", async () => {
      const metadata = await runStartedMetadata(new PlainAgent());

      expect(metadata.agents).toEqual([
        { name: "PlainAgent", role: "agent" },
        { name: "UserSimulatorAgent", role: "user" },
        { name: "JudgeAgent", role: "judge" },
      ]);
    });
  });

  describe("when the user sets a langwatch metadata key", () => {
    it("keeps the agents list at the top level and the key untouched", async () => {
      const metadata = await runStartedMetadata(new PlainAgent(), {
        langwatch: { threadId: "thread-1" },
      });

      expect((metadata.agents as { name: string }[])[0]!.name).toBe(
        "PlainAgent"
      );
      expect(metadata.langwatch).toEqual({ threadId: "thread-1" });
    });
  });

  describe("when the user sets other metadata keys", () => {
    it("passes them through next to the agents list", async () => {
      const metadata = await runStartedMetadata(new PlainAgent(), {
        promptId: "abc-123",
        environment: "staging",
      });

      expect(metadata.promptId).toBe("abc-123");
      expect(metadata.environment).toBe("staging");
      expect((metadata.agents as unknown[]).length).toBe(3);
    });
  });
});
