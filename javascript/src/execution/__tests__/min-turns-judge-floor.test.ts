/**
 * minTurns executor behavior (ADR-005, issue #899): startup validation and the
 * end-to-end floor. Below the floor the judge returns continue without any LLM
 * call at all; the first call the stub sees is the post-floor decision call.
 * The stub honors the offered tool set the way a real LLM must, so the run's
 * turn count observably reflects the floor.
 */

import { describe, it, expect, vi } from "vitest";

import { judgeAgent } from "../../agents";
import { JudgeSpanCollector } from "../../agents/judge/judge-span-collector";
import type { InvokeLLMParams, InvokeLLMResult } from "../../agents/types";
import {
  AgentRole,
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { ScenarioExecution } from "../scenario-execution";

vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-5-mini", temperature: 0 },
  }),
}));

class CountingAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  calls = 0;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    this.calls += 1;
    return { role: "assistant" as const, content: `agent reply ${this.calls}` };
  }
}

class CountingUserSim extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  calls = 0;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    this.calls += 1;
    return `user turn ${this.calls}`;
  }
}

function makeVerdictCall(): InvokeLLMResult {
  return {
    text: "",
    content: [],
    toolCalls: [
      {
        toolName: "make_verdict",
        type: "tool-call" as const,
        toolCallId: "tc-make-verdict",
        input: {},
      },
    ],
    toolResults: [],
  } as unknown as InvokeLLMResult;
}

function finishTestCall(): InvokeLLMResult {
  return {
    text: "",
    content: [],
    toolCalls: [
      {
        toolName: "finish_test",
        type: "tool-call" as const,
        toolCallId: "tc-finish",
        input: {
          criteria: { agent_greets_the_user_politely: "true" },
          reasoning: "The agent greeted the user politely.",
          verdict: "success",
        },
      },
    ],
    toolResults: [],
  } as unknown as InvokeLLMResult;
}

describe("given a scenario configured with minTurns", () => {
  describe("when minTurns is outside the non-negative integer domain", () => {
    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      "rejects %s at startup",
      (minTurns) => {
        expect(
          () =>
            new ScenarioExecution(
              {
                name: "invalid floor domain",
                description: "minTurns must be a non-negative integer",
                agents: [],
                minTurns,
              },
              [],
              "test-batch-id",
            ),
        ).toThrow("minTurns must be a non-negative integer");
      },
    );

    it("accepts zero", () => {
      expect(
        () =>
          new ScenarioExecution(
            {
              name: "zero floor",
              description: "zero disables the floor without omitting it",
              agents: [],
              minTurns: 0,
            },
            [],
            "test-batch-id",
          ),
      ).not.toThrow();
    });
  });

  describe("when minTurns exceeds maxTurns", () => {
    it("fails at startup with a clear error", () => {
      expect(
        () =>
          new ScenarioExecution(
            {
              name: "invalid floor",
              description: "minTurns above maxTurns",
              agents: [],
              maxTurns: 5,
              minTurns: 6,
            },
            [],
            "test-batch-id",
          ),
      ).toThrow("minTurns (6) cannot exceed maxTurns (5)");
    });

    it("validates against the default maxTurns when maxTurns is unset", () => {
      expect(
        () =>
          new ScenarioExecution(
            {
              name: "invalid floor, default max",
              description: "minTurns above the default maxTurns of 10",
              agents: [],
              minTurns: 11,
            },
            [],
            "test-batch-id",
          ),
      ).toThrow("minTurns (11) cannot exceed maxTurns (10)");
    });

    it("accepts minTurns equal to maxTurns", () => {
      expect(
        () =>
          new ScenarioExecution(
            {
              name: "floor equals ceiling",
              description: "minTurns == maxTurns is allowed",
              agents: [],
              maxTurns: 5,
              minTurns: 5,
            },
            [],
            "test-batch-id",
          ),
      ).not.toThrow();
    });
  });

  describe("when an eager judge would end the run on turn 1", () => {
    it("the floor holds the run open until minTurns has passed", async () => {
      const agentUnderTest = new CountingAgent();
      const sim = new CountingUserSim();

      const judge = judgeAgent({
        criteria: ["Agent greets the user politely"],
        spanCollector: new JudgeSpanCollector(),
      });
      const offeredByCall: string[][] = [];
      judge.invokeLLM = async (params: InvokeLLMParams) => {
        const offered = Object.keys(params.tools ?? {}).sort();
        offeredByCall.push(offered);
        // Eager judge: volunteers the verdict the moment it is allowed to.
        return offered.includes("finish_test")
          ? finishTestCall()
          : makeVerdictCall();
      };

      const execution = new ScenarioExecution(
        {
          name: "floor holds",
          description: "judge is satisfied on turn 1 but the floor is 2",
          agents: [agentUnderTest, sim, judge],
          maxTurns: 5,
          minTurns: 2,
        },
        [
          async (_state, executor) => {
            await executor.proceed();
          },
        ],
        "test-batch-id",
      );

      const result = await execution.execute();

      // Turns 1 and 2 are gated below the floor with no LLM call at all
      // (judge observes 0-based currentTurn); turn 3 is the first decision
      // call, and its make_verdict answer leads straight to the verdict call.
      expect(offeredByCall).toEqual([
        ["continue_test", "make_verdict"],
        ["finish_test"],
      ]);
      expect(sim.calls).toBe(3);
      expect(result.success).toBe(true);
    });
  });
});
