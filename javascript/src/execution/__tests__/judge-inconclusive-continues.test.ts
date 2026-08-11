/**
 * Regression guard for issue #886: a judge that calls finish_test with
 * verdict "inconclusive" mid-conversation (nothing forcing a verdict) must
 * let the conversation CONTINUE, not end the run as FAILED.
 *
 * Uses the real judgeAgent with only invokeLLM stubbed, so the test executes
 * the actual parseToolCalls path that carried the bug — the run used to stop
 * after turn 1, which in the UI read as "the user simulator stopped
 * responding".
 */

import { describe, it, expect, vi } from "vitest";

import { judgeAgent } from "../../agents";
import { JudgeSpanCollector } from "../../agents/judge/judge-span-collector";
import type { InvokeLLMResult } from "../../agents/types";
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

function finishTestCall(
  verdict: "success" | "inconclusive",
  criterionValue: "true" | "inconclusive",
): InvokeLLMResult {
  return {
    text: "",
    content: [],
    toolCalls: [
      {
        toolName: "finish_test",
        type: "tool-call" as const,
        toolCallId: `tc-${verdict}`,
        input: {
          criteria: { agent_greets_the_user_politely: criterionValue },
          reasoning:
            verdict === "inconclusive"
              ? "Too early to tell — the conversation should continue."
              : "The agent greeted the user politely.",
          verdict,
        },
      },
    ],
    toolResults: [],
  } as unknown as InvokeLLMResult;
}

describe("given a judge that hedges on the first turn (#886)", () => {
  describe("when finish_test returns verdict inconclusive with turns remaining", () => {
    it("continues the conversation and reaches the real verdict", async () => {
      const agentUnderTest = new CountingAgent();
      const sim = new CountingUserSim();

      const judge = judgeAgent({
        criteria: ["Agent greets the user politely"],
        // Explicit collector so the test never couples to the process-global
        // OTel span collector singleton.
        spanCollector: new JudgeSpanCollector(),
      });
      let judgeLLMCalls = 0;
      judge.invokeLLM = async () => {
        judgeLLMCalls += 1;
        return judgeLLMCalls === 1
          ? finishTestCall("inconclusive", "inconclusive")
          : finishTestCall("success", "true");
      };

      const execution = new ScenarioExecution(
        {
          name: "inconclusive continues",
          description: "judge hedges on turn 1, decides on turn 2",
          agents: [agentUnderTest, sim, judge],
        },
        [
          async (_state, executor) => {
            await executor.proceed();
          },
        ],
        "test-batch-id",
      );

      const result = await execution.execute();

      // Before the fix the run died here: success=false after ONE turn, with
      // the judge's own reasoning saying the verdict should be inconclusive.
      expect(judgeLLMCalls).toBe(2);
      expect(sim.calls).toBe(2);
      expect(result.success).toBe(true);
      expect(result.metCriteria).toContain("Agent greets the user politely");
    });
  });
});
