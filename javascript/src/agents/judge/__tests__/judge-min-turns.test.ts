/**
 * minTurns judge floor (ADR-005, issue #899): below the floor an UNFORCED
 * judge call may not volunteer a verdict — finish_test is withheld from its
 * tool set entirely. Forced judgments (explicit judge() checkpoint, last turn)
 * always keep their terminal contract, and a gated large-trace call whose
 * discovery loop exhausts resolves to continue instead of forcing a verdict
 * against a tool set that does not contain finish_test.
 *

 * The judge observes a 0-based currentTurn (the executor overrides the
 * initial newTurn() back to 0, so the call on turn N sees currentTurn N-1):
 * with minTurns: 4 the floor holds through the turn-4 call (currentTurn 3)
 * and finish_test is first offered on the turn-5 call (currentTurn 4). Tests
 * pin that observable sequence; the end-to-end pin lives in
 * execution/__tests__/min-turns-judge-floor.test.ts.
 */

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, it, expect, vi } from "vitest";
import { AgentInput, AgentRole } from "../../../domain";
import { InvokeLLMParams, InvokeLLMResult } from "../../types";
import { judgeAgent, JudgeAgentConfig } from "../judge-agent";
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

function createGatedAgent() {
  const agent = judgeAgent({
    criteria: ["Agent responds politely"],
    spanCollector: new JudgeSpanCollector(),
  });
  let capturedParams: InvokeLLMParams | undefined;
  agent.invokeLLM = async (params) => {
    capturedParams = params;
    return mockLLMResult("continue_test", {});
  };
  return { agent, params: () => capturedParams };
}

describe("given a scenario with a minTurns floor", () => {
  describe("when the judge is called unforced below the floor", () => {
    it("withholds finish_test and continues", async () => {
      const { agent, params } = createGatedAgent();

      const result = await agent.call(
        createInput({
          scenarioState: { currentTurn: 2 },
          scenarioConfig: { minTurns: 4 },
        } as Partial<AgentInput>)
      );

      const toolNames = Object.keys(params()!.tools ?? {});
      expect(toolNames).toContain("continue_test");
      expect(toolNames).not.toContain("finish_test");
      expect(params()!.toolChoice).toBe("required");
      expect(result).toBeNull();
    });

    it("tells the judge in the system prompt that ending is unavailable", async () => {
      const { agent, params } = createGatedAgent();

      await agent.call(
        createInput({
          scenarioState: { currentTurn: 2 },
          scenarioConfig: { minTurns: 4 },
        } as Partial<AgentInput>)
      );

      const systemMsg = params()!.messages?.find((m) => m.role === "system");
      expect(systemMsg?.content).toContain(
        "ending the test is not available on this turn"
      );
    });

    it("appends the gated line to a custom systemPrompt override too", async () => {
      const agent = judgeAgent({
        criteria: ["Agent responds politely"],
        spanCollector: new JudgeSpanCollector(),
        systemPrompt: "You are a strict reviewer.",
      });
      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("continue_test", {});
      };

      await agent.call(
        createInput({
          scenarioState: { currentTurn: 1 },
          scenarioConfig: { minTurns: 3 },
        } as Partial<AgentInput>)
      );

      const systemMsg = capturedParams!.messages?.find(
        (m) => m.role === "system"
      );
      expect(systemMsg?.content).toContain("You are a strict reviewer.");
      expect(systemMsg?.content).toContain(
        "ending the test is not available on this turn"
      );
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

      // maxTurns 5 → currentTurn 4 (the turn-5 call) is the last-message
      // call. minTurns 5 would otherwise gate it — forced wins.
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
    it("offers the identical tool set and no gated prompt line", async () => {
      const { agent, params } = createGatedAgent();

      await agent.call(
        createInput({
          scenarioState: { currentTurn: 1 },
        } as Partial<AgentInput>)
      );

      const toolNames = Object.keys(params()!.tools ?? {});
      expect(toolNames).toContain("continue_test");
      expect(toolNames).toContain("finish_test");
      const systemMsg = params()!.messages?.find((m) => m.role === "system");
      expect(systemMsg?.content).not.toContain(
        "ending the test is not available on this turn"
      );
    });
  });

  describe("across the turn sequence with minTurns: 4", () => {
    it("first offers finish_test on the turn-5 call", async () => {
      const offeredByCurrentTurn: Record<number, boolean> = {};

      // The call on turn N observes currentTurn N-1, so turns 1..6 are
      // currentTurn 0..5.
      for (let currentTurn = 0; currentTurn <= 5; currentTurn++) {
        const { agent, params } = createGatedAgent();
        await agent.call(
          createInput({
            scenarioState: { currentTurn },
            scenarioConfig: { minTurns: 4 },
          } as Partial<AgentInput>)
        );
        offeredByCurrentTurn[currentTurn] = Object.keys(
          params()!.tools ?? {}
        ).includes("finish_test");
      }

      expect(offeredByCurrentTurn).toEqual({
        0: false, // turn 1
        1: false, // turn 2
        2: false, // turn 3
        3: false, // turn 4
        4: true, // turn 5 — the floor of 4 turns has passed
        5: true, // turn 6
      });
    });
  });

  describe("when a gated large-trace call exhausts discovery", () => {
    it("continues without forcing a verdict", async () => {
      const collector = createMockSpanCollector(createLargeTrace());
      const config: JudgeAgentConfig = {
        criteria: ["Agent works correctly"],
        spanCollector: collector,
        maxDiscoverySteps: 3,
      };
      const agent = judgeAgent(config);

      let callCount = 0;
      agent.invokeLLM = async (params) => {
        callCount++;
        // A gated call must never see finish_test on any step.
        expect(Object.keys(params.tools ?? {})).not.toContain("finish_test");
        // Discovery-only completion: no terminal tool → exhausted.
        return {
          text: "",
          content: [],
          toolCalls: [
            {
              toolName: "expand_trace",
              input: { span_ids: ["0000000000000000"] },
              type: "tool-call" as const,
              toolCallId: "tc-1",
            },
          ],
          toolResults: [],
        } as unknown as InvokeLLMResult;
      };

      const result = await agent.call(
        createInput({
          scenarioState: { currentTurn: 2 },
          scenarioConfig: { minTurns: 4 },
        } as Partial<AgentInput>)
      );

      // One LLM call only: forceVerdict (which would pin finish_test and make
      // a second call) must not fire below the floor — before ADR-005's
      // Decision 5 that second call would have been rejected by the provider
      // for pinning a tool absent from the tools dict, killing the run.
      expect(callCount).toBe(1);
      expect(result).toBeNull();
    });
  });
});
