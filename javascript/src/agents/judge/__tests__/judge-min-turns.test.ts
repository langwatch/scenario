/**
 * minTurns judge floor (ADR-005, issue #899): below the floor an UNFORCED
 * judge call may not volunteer a verdict. With the two-phase judge the floor
 * is enforced before any LLM call: the decision between continuing and
 * judging is predetermined (the conversation must continue), so the judge
 * returns continue without spending a completion. Forced judgments (explicit
 * judge() checkpoint, last turn) always keep their terminal contract.
 *
 * The judge observes a 0-based currentTurn (the executor overrides the
 * initial newTurn() back to 0, so the call on turn N sees currentTurn N-1):
 * with minTurns: 4 the floor holds through the turn-4 call (currentTurn 3)
 * and the first decision call happens on the turn-5 call (currentTurn 4).
 * Tests pin that observable sequence; the end-to-end pin lives in
 * execution/__tests__/min-turns-judge-floor.test.ts.
 */

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, it, expect, vi } from "vitest";
import { AgentInput, AgentRole } from "../../../domain";
import { InvokeLLMParams, InvokeLLMResult } from "../../types";
import { judgeAgent } from "../judge-agent";
import { JudgeSpanCollector } from "../judge-span-collector";
import { createSpan } from "./helpers/create-span";

vi.mock("../../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4o-mini", temperature: 0 },
  }),
}));

function createLargeTrace(): ReadableSpan[] {
  return Array.from({ length: 200 }, (_, i) =>
    createSpan({
      spanId: `${i.toString(16).padStart(16, "0")}`,
      name: `operation-${i}`,
      startTime: [1700000000 + i, 0],
      endTime: [1700000000 + i, 100_000_000],
      attributes: {
        "gen_ai.prompt": "a".repeat(200),
        "gen_ai.completion": "b".repeat(200),
        "tool.input": "c".repeat(200),
      },
    })
  );
}

function createMockSpanCollector(spans: ReadableSpan[]): JudgeSpanCollector {
  const collector = new JudgeSpanCollector();
  for (const span of spans) {
    (span.attributes as Record<string, unknown>)["langwatch.thread.id"] =
      "test-thread";
    collector.onEnd(span);
  }
  return collector;
}

function createInput(overrides?: Partial<AgentInput>): AgentInput {
  return {
    threadId: "test-thread",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    newMessages: [{ role: "assistant", content: "Hi there!" }],
    requestedRole: AgentRole.JUDGE,
    scenarioState: { currentTurn: 1, ...(overrides?.scenarioState as object) },
    scenarioConfig: {
      name: "test",
      description: "A test scenario",
      maxTurns: 10,
      ...(overrides?.scenarioConfig as object),
    },
    ...overrides,
  } as AgentInput;
}

function mockLLMResult(toolName: string, input: unknown): InvokeLLMResult {
  return {
    text: "",
    content: [],
    toolCalls: [
      { toolName, input, type: "tool-call" as const, toolCallId: "tc-1" },
    ],
    toolResults: [],
  } as unknown as InvokeLLMResult;
}

function createContinuingAgent() {
  const agent = judgeAgent({
    criteria: ["Agent responds politely"],
    spanCollector: new JudgeSpanCollector(),
  });
  const calls: InvokeLLMParams[] = [];
  agent.invokeLLM = async (params) => {
    calls.push(params);
    return mockLLMResult("continue_test", {});
  };
  return { agent, calls };
}

describe("given a scenario with a minTurns floor", () => {
  describe("when the judge is called unforced below the floor", () => {
    it("continues without any LLM call", async () => {
      const { agent, calls } = createContinuingAgent();

      const result = await agent.call(
        createInput({
          scenarioState: { currentTurn: 2 },
          scenarioConfig: { minTurns: 4 },
        } as Partial<AgentInput>)
      );

      expect(calls).toHaveLength(0);
      expect(result).toBeNull();
    });

    it("a custom systemPrompt override changes nothing below the floor", async () => {
      const agent = judgeAgent({
        criteria: ["Agent responds politely"],
        spanCollector: new JudgeSpanCollector(),
        systemPrompt: "You are a strict reviewer.",
      });
      agent.invokeLLM = async () => {
        throw new Error("no LLM call below the floor");
      };

      const result = await agent.call(
        createInput({
          scenarioState: { currentTurn: 1 },
          scenarioConfig: { minTurns: 3 },
        } as Partial<AgentInput>)
      );

      expect(result).toBeNull();
    });
  });

  describe("when a judge() checkpoint fires below the floor", () => {
    it("still offers finish_test pinned and delivers a terminal verdict", async () => {
      const agent = judgeAgent({
        criteria: ["Agent responds politely"],
        spanCollector: new JudgeSpanCollector(),
      });
      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("finish_test", {
          criteria: { agent_responds_politely: "false" },
          reasoning: "The agent was rude on turn 1.",
          verdict: "failure",
        });
      };

      const result = await agent.call(
        createInput({
          judgmentRequest: {},
          scenarioState: { currentTurn: 1 },
          scenarioConfig: { minTurns: 4 },
        } as Partial<AgentInput>)
      );

      const toolNames = Object.keys(capturedParams!.tools ?? {});
      expect(toolNames).toContain("finish_test");
      expect(capturedParams!.toolChoice).toEqual({
        type: "tool",
        toolName: "finish_test",
      });
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
    });
  });

  describe("when the last turn lands at or below the floor", () => {
    it("the last-turn forced judgment still offers finish_test", async () => {
      const agent = judgeAgent({
        criteria: ["Agent responds politely"],
        spanCollector: new JudgeSpanCollector(),
      });
      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("finish_test", {
          criteria: { agent_responds_politely: "true" },
          reasoning: "Polite throughout.",
          verdict: "success",
        });
      };

      // maxTurns 5 -> currentTurn 4 (the turn-5 call) is the last-message
      // call. minTurns 5 would otherwise gate it; forced wins.
      const result = await agent.call(
        createInput({
          scenarioState: { currentTurn: 4 },
          scenarioConfig: { maxTurns: 5, minTurns: 5 },
        } as Partial<AgentInput>)
      );

      const toolNames = Object.keys(capturedParams!.tools ?? {});
      expect(toolNames).toContain("finish_test");
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
    });
  });

  describe("when minTurns is unset", () => {
    it("makes the decision call from the first turn", async () => {
      const { agent, calls } = createContinuingAgent();

      await agent.call(
        createInput({
          scenarioState: { currentTurn: 1 },
        } as Partial<AgentInput>)
      );

      expect(calls).toHaveLength(1);
      const toolNames = Object.keys(calls[0]!.tools ?? {});
      expect(toolNames).toContain("continue_test");
      expect(toolNames).toContain("make_verdict");
      expect(toolNames).not.toContain("finish_test");
    });
  });

  describe("across the turn sequence with minTurns: 4", () => {
    it("first makes the decision call on the turn-5 call", async () => {
      const llmCalledByCurrentTurn: Record<number, boolean> = {};

      // The call on turn N observes currentTurn N-1, so turns 1..6 are
      // currentTurn 0..5.
      for (let currentTurn = 0; currentTurn <= 5; currentTurn++) {
        const { agent, calls } = createContinuingAgent();
        await agent.call(
          createInput({
            scenarioState: { currentTurn },
            scenarioConfig: { minTurns: 4 },
          } as Partial<AgentInput>)
        );
        llmCalledByCurrentTurn[currentTurn] = calls.length > 0;
      }

      expect(llmCalledByCurrentTurn).toEqual({
        0: false, // turn 1
        1: false, // turn 2
        2: false, // turn 3
        3: false, // turn 4
        4: true, // turn 5: the floor of 4 turns has passed
        5: true, // turn 6
      });
    });
  });

  describe("when a large transcript would trigger discovery below the floor", () => {
    it("still makes no LLM call", async () => {
      // The floor check runs before the decision phase, so a trace that would
      // otherwise route into the discovery loop still costs zero completions
      // below the floor.
      const collector = createMockSpanCollector(createLargeTrace());
      const agent = judgeAgent({
        criteria: ["Agent works correctly"],
        spanCollector: collector,
        maxDiscoverySteps: 3,
      });
      agent.invokeLLM = async () => {
        throw new Error("no LLM call below the floor");
      };

      const result = await agent.call(
        createInput({
          scenarioState: { currentTurn: 2 },
          scenarioConfig: { minTurns: 4 },
        } as Partial<AgentInput>)
      );

      expect(result).toBeNull();
    });
  });
});
