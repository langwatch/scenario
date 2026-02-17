import { describe, it, expect } from "vitest";
import {
  AgentRole,
  AgentAdapter,
  JudgeAgentAdapter,
  AgentInput,
  AgentReturnTypes,
} from "../../domain";
import { user, agent, judge, succeed } from "../../script";
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

class InlineCriteriaMockJudgeAgent extends JudgeAgentAdapter {
  criteria: string[] = [];

  constructor(criteria: string[] = []) {
    super();
    this.criteria = criteria;
  }

  async call(input: AgentInput) {
    if (!input.judgmentRequest) {
      return null;
    }
    const effectiveCriteria = input.judgmentRequest.criteria ?? this.criteria;
    const hasFail = effectiveCriteria.some((c) =>
      c.toLowerCase().includes("fail")
    );
    if (hasFail) {
      return {
        success: false,
        reasoning: "Criteria failed",
        metCriteria: effectiveCriteria.filter(
          (c) => !c.toLowerCase().includes("fail")
        ),
        unmetCriteria: effectiveCriteria.filter((c) =>
          c.toLowerCase().includes("fail")
        ),
      };
    }
    return {
      success: true,
      reasoning: "All criteria passed",
      metCriteria: [...effectiveCriteria],
      unmetCriteria: [],
    };
  }
}

describe("Inline criteria on judge()", () => {
  it("checkpoint pass continues the script", async () => {
    let agentCallCount = 0;

    class CountingAgent extends AgentAdapter {
      role = AgentRole.AGENT;
      async call(_input: AgentInput): Promise<AgentReturnTypes> {
        agentCallCount++;
        return { role: "assistant" as const, content: "response" };
      }
    }

    const execution = new ScenarioExecution(
      {
        name: "test inline pass",
        description: "test",
        agents: [
          new CountingAgent(),
          new MockUserSimulatorAgent(),
          new InlineCriteriaMockJudgeAgent(),
        ],
      },
      [
        user("hello"),
        agent(),
        judge({ criteria: ["criterion A passes"] }),
        user("follow up"),
        agent(),
        succeed(),
      ]
    );

    const result = await execution.execute();
    expect(result.success).toBe(true);
    expect(agentCallCount).toBe(2);
    expect(result.metCriteria).toContain("criterion A passes");
  });

  it("checkpoint fail stops the scenario", async () => {
    let agentCallCount = 0;

    class CountingAgent extends AgentAdapter {
      role = AgentRole.AGENT;
      async call(_input: AgentInput): Promise<AgentReturnTypes> {
        agentCallCount++;
        return { role: "assistant" as const, content: "response" };
      }
    }

    const execution = new ScenarioExecution(
      {
        name: "test inline fail",
        description: "test",
        agents: [
          new CountingAgent(),
          new MockUserSimulatorAgent(),
          new InlineCriteriaMockJudgeAgent(),
        ],
      },
      [
        user("hello"),
        agent(),
        judge({ criteria: ["this will fail"] }),
        user("should not reach"),
        agent(),
        succeed(),
      ]
    );

    const result = await execution.execute();
    expect(result.success).toBe(false);
    expect(agentCallCount).toBe(1);
    expect(result.unmetCriteria).toContain("this will fail");
  });

  it("multiple checkpoints accumulate passed criteria", async () => {
    const execution = new ScenarioExecution(
      {
        name: "test accumulate",
        description: "test",
        agents: [
          new MockAgent(),
          new MockUserSimulatorAgent(),
          new InlineCriteriaMockJudgeAgent(),
        ],
      },
      [
        user("hello"),
        agent(),
        judge({ criteria: ["criterion A passes"] }),
        user("more"),
        agent(),
        judge({ criteria: ["criterion B passes", "criterion C passes"] }),
      ]
    );

    const result = await execution.execute();
    expect(result.success).toBe(true);
    expect(result.metCriteria).toContain("criterion A passes");
    expect(result.metCriteria).toContain("criterion B passes");
    expect(result.metCriteria).toContain("criterion C passes");
  });

  it("script ending with only passed checkpoints succeeds", async () => {
    const execution = new ScenarioExecution(
      {
        name: "test end of script",
        description: "test",
        agents: [
          new MockAgent(),
          new MockUserSimulatorAgent(),
          new InlineCriteriaMockJudgeAgent(),
        ],
      },
      [
        user("hello"),
        agent(),
        judge({ criteria: ["criterion A passes"] }),
      ]
    );

    const result = await execution.execute();
    expect(result.success).toBe(true);
    expect(result.metCriteria).toContain("criterion A passes");
  });

  it("restores original criteria after inline judge call", async () => {
    const judgeAgent = new InlineCriteriaMockJudgeAgent(["original criterion"]);

    const execution = new ScenarioExecution(
      {
        name: "test restore",
        description: "test",
        agents: [
          new MockAgent(),
          new MockUserSimulatorAgent(),
          judgeAgent,
        ],
      },
      [
        user("hello"),
        agent(),
        judge({ criteria: ["inline criterion passes"] }),
        succeed(),
      ]
    );

    await execution.execute();
    expect(judgeAgent.criteria).toEqual(["original criterion"]);
  });

  it("failed checkpoint includes previously accumulated criteria", async () => {
    const execution = new ScenarioExecution(
      {
        name: "test fail with accumulated",
        description: "test",
        agents: [
          new MockAgent(),
          new MockUserSimulatorAgent(),
          new InlineCriteriaMockJudgeAgent(),
        ],
      },
      [
        user("hello"),
        agent(),
        judge({ criteria: ["criterion A passes"] }),
        user("more"),
        agent(),
        judge({ criteria: ["this will fail"] }),
      ]
    );

    const result = await execution.execute();
    expect(result.success).toBe(false);
    expect(result.metCriteria).toContain("criterion A passes");
    expect(result.unmetCriteria).toContain("this will fail");
  });
});
