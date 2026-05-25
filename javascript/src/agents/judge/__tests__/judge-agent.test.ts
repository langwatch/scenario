import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { judgeAgent, JudgeAgentConfig } from "../judge-agent";
import { JudgeSpanCollector } from "../judge-span-collector";
import { AgentInput, AgentRole } from "../../../domain";
import { DEFAULT_TOKEN_THRESHOLD } from "../estimate-tokens";
import { InvokeLLMParams, InvokeLLMResult } from "../../types";
import { createSpan } from "./helpers/create-span";

function createSmallTrace(): ReadableSpan[] {
  return [
    createSpan({
      spanId: "a1b2c3d4e5f67890",
      name: "llm.call",
      startTime: [1700000000, 0],
      endTime: [1700000000, 500_000_000],
      attributes: { model: "gpt-4" },
    }),
  ];
}

function createLargeTrace(): ReadableSpan[] {
  // Create spans with enough attributes to exceed the token threshold
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
    collector.onEnd(span);
  }
  return collector;
}

function createBaseInput(overrides?: Partial<AgentInput>): AgentInput {
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
      maxTurns: 5,
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
      {
        toolName,
        input,
        type: "tool-call" as const,
        toolCallId: "tc-1",
      },
    ],
    toolResults: [],
  } as unknown as InvokeLLMResult;
}

// Mock getProjectConfig to avoid filesystem dependency
vi.mock("../../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4o-mini", temperature: 0 },
  }),
}));

describe("JudgeAgent", () => {
  describe("when trace is small (under token threshold)", () => {
    it("uses single LLM call without expand/grep tools", async () => {
      const smallTrace = createSmallTrace();
      const collector = createMockSpanCollector(smallTrace);

      for (const span of smallTrace) {
        (span.attributes as Record<string, unknown>)["langwatch.thread.id"] =
          "test-thread";
      }

      const config: JudgeAgentConfig = {
        criteria: ["Agent responds politely"],
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("continue_test", {});
      };

      await agent.call(createBaseInput());

      expect(capturedParams).toBeDefined();
      const toolNames = Object.keys(capturedParams!.tools ?? {});
      expect(toolNames).toContain("continue_test");
      expect(toolNames).toContain("finish_test");
      expect(toolNames).not.toContain("expand_trace");
      expect(toolNames).not.toContain("grep_trace");

      // Should NOT have stopWhen (single-step mode)
      expect(capturedParams!.stopWhen).toBeUndefined();
    });
  });

  describe("when trace is large (over token threshold)", () => {
    it("provides expand_trace and grep_trace tools and uses stopWhen", async () => {
      const largeTrace = createLargeTrace();
      const collector = createMockSpanCollector(largeTrace);

      for (const span of largeTrace) {
        (span.attributes as Record<string, unknown>)["langwatch.thread.id"] =
          "test-thread";
      }

      const config: JudgeAgentConfig = {
        criteria: ["Agent uses the correct tool"],
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("finish_test", {
          criteria: { agent_uses_the_correct_tool: "true" },
          reasoning: "The tool was used correctly",
          verdict: "success",
        });
      };

      await agent.call(createBaseInput());

      expect(capturedParams).toBeDefined();
      const toolNames = Object.keys(capturedParams!.tools ?? {});
      expect(toolNames).toContain("expand_trace");
      expect(toolNames).toContain("grep_trace");
      expect(toolNames).toContain("continue_test");
      expect(toolNames).toContain("finish_test");

      // Should set stopWhen for multi-turn tool execution (AI SDK v6)
      expect(capturedParams!.stopWhen).toBeDefined();
    });

    it("renders structure-only digest with usage hint in the user message", async () => {
      const largeTrace = createLargeTrace();
      const collector = createMockSpanCollector(largeTrace);

      for (const span of largeTrace) {
        (span.attributes as Record<string, unknown>)["langwatch.thread.id"] =
          "test-thread";
      }

      const config: JudgeAgentConfig = {
        criteria: ["Agent works correctly"],
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("continue_test", {});
      };

      await agent.call(createBaseInput());

      const userMsg = capturedParams!.messages?.find(
        (m) => "role" in m && m.role === "user"
      );
      expect(userMsg).toBeDefined();
      const content =
        typeof userMsg!.content === "string"
          ? userMsg!.content
          : JSON.stringify(userMsg!.content);
      expect(content).toContain("expand_trace");
      expect(content).toContain("grep_trace");
      // Should NOT contain detailed attributes
      expect(content).not.toContain("gen_ai.prompt");
    });
  });

  describe("when custom system prompt is used with large trace", () => {
    it("preserves the custom system prompt", async () => {
      const largeTrace = createLargeTrace();
      const collector = createMockSpanCollector(largeTrace);

      for (const span of largeTrace) {
        (span.attributes as Record<string, unknown>)["langwatch.thread.id"] =
          "test-thread";
      }

      const customPrompt = "You are a special judge with custom rules.";
      const config: JudgeAgentConfig = {
        criteria: ["Custom criterion"],
        systemPrompt: customPrompt,
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("continue_test", {});
      };

      await agent.call(createBaseInput());

      const systemMsg = capturedParams!.messages?.find(
        (m) => "role" in m && m.role === "system"
      );
      expect(systemMsg).toBeDefined();
      const content =
        typeof systemMsg!.content === "string"
          ? systemMsg!.content
          : JSON.stringify(systemMsg!.content);
      expect(content).toContain(customPrompt);
    });
  });

  describe("when trace is empty", () => {
    it("renders 'No spans recorded.' regardless of mode", async () => {
      const collector = createMockSpanCollector([]);

      const config: JudgeAgentConfig = {
        criteria: ["Test criterion"],
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("continue_test", {});
      };

      await agent.call(createBaseInput());

      const userMsg = capturedParams!.messages?.find(
        (m) => "role" in m && m.role === "user"
      );
      const content =
        typeof userMsg!.content === "string"
          ? userMsg!.content
          : JSON.stringify(userMsg!.content);
      expect(content).toContain("No spans recorded.");

      // Should NOT have expand/grep tools for empty trace
      const toolNames = Object.keys(capturedParams!.tools ?? {});
      expect(toolNames).not.toContain("expand_trace");
      expect(toolNames).not.toContain("grep_trace");
    });
  });

  describe("when trace is exactly at the threshold boundary", () => {
    it("does not provide progressive discovery tools or stopWhen", async () => {
      const collector = new JudgeSpanCollector();
      const targetChars = DEFAULT_TOKEN_THRESHOLD * 4;

      const spans = [
        createSpan({
          spanId: "a1b2c3d400000000",
          name: "test.operation",
          startTime: [1700000000, 0],
          endTime: [1700000000, 100_000_000],
          attributes: {
            content: "x".repeat(targetChars - 200),
          },
        }),
      ];

      (spans[0]!.attributes as Record<string, unknown>)[
        "langwatch.thread.id"
      ] = "test-thread";

      for (const span of spans) {
        collector.onEnd(span);
      }

      const config: JudgeAgentConfig = {
        criteria: ["Test"],
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("continue_test", {});
      };

      await agent.call(createBaseInput());

      expect(capturedParams).toBeDefined();
      const toolNames = Object.keys(capturedParams!.tools ?? {});
      expect(toolNames).not.toContain("expand_trace");
      expect(toolNames).not.toContain("grep_trace");
      expect(capturedParams!.stopWhen).toBeUndefined();
    });
  });

  describe("when the judge finishes with a verdict in progressive mode", () => {
    it("returns the correct JudgeResult", async () => {
      const largeTrace = createLargeTrace();
      const collector = createMockSpanCollector(largeTrace);

      for (const span of largeTrace) {
        (span.attributes as Record<string, unknown>)["langwatch.thread.id"] =
          "test-thread";
      }

      const config: JudgeAgentConfig = {
        criteria: ["Agent responds correctly", "Agent uses tools"],
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      agent.invokeLLM = async () => {
        return mockLLMResult("finish_test", {
          criteria: {
            agent_responds_correctly: "true",
            agent_uses_tools: "false",
          },
          reasoning: "Agent responded but did not use tools",
          verdict: "failure",
        });
      };

      const result = await agent.call(createBaseInput());

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.reasoning).toBe("Agent responded but did not use tools");
      expect(result!.metCriteria).toContain("Agent responds correctly");
      expect(result!.unmetCriteria).toContain("Agent uses tools");
    });
  });

  describe("isLastMessage boundary detection", () => {
    const cases = [
      { currentTurn: 4, maxTurns: 5, expectLast: true, label: "last turn (0-indexed)" },
      { currentTurn: 3, maxTurns: 5, expectLast: false, label: "not yet last turn" },
      { currentTurn: 5, maxTurns: 5, expectLast: true, label: "past max (>=)" },
      { currentTurn: 9, maxTurns: 10, expectLast: true, label: "max=10, turn 9 is last" },
      { currentTurn: 8, maxTurns: 10, expectLast: false, label: "max=10, turn 8 is not last" },
    ];

    for (const { currentTurn, maxTurns, expectLast, label } of cases) {
      it(`${label}: isLastMessage=${expectLast}`, async () => {
        const smallTrace = createSmallTrace();
        const collector = createMockSpanCollector(smallTrace);
        for (const span of smallTrace) {
          (span.attributes as Record<string, unknown>)["langwatch.thread.id"] = "test-thread";
        }

        const config: JudgeAgentConfig = {
          criteria: ["Test criterion"],
          spanCollector: collector,
        };

        const agent = judgeAgent(config);

        let capturedParams: InvokeLLMParams | undefined;
        agent.invokeLLM = async (params) => {
          capturedParams = params;
          return mockLLMResult(
            expectLast ? "finish_test" : "continue_test",
            expectLast
              ? { criteria: { test_criterion: "true" }, reasoning: "ok", verdict: "success" }
              : {}
          );
        };

        await agent.call(createBaseInput({
          scenarioState: { currentTurn } as any,
          scenarioConfig: { name: "test", description: "test", maxTurns } as any,
        }));

        expect(capturedParams).toBeDefined();
        if (expectLast) {
          expect(capturedParams!.toolChoice).toEqual({ type: "tool", toolName: "finish_test" });
        } else {
          expect(capturedParams!.toolChoice).toBe("required");
        }
      });
    }
  });

  describe("when the judge continues in progressive mode", () => {
    it("returns null to allow the scenario to proceed", async () => {
      const largeTrace = createLargeTrace();
      const collector = createMockSpanCollector(largeTrace);

      for (const span of largeTrace) {
        (span.attributes as Record<string, unknown>)["langwatch.thread.id"] =
          "test-thread";
      }

      const config: JudgeAgentConfig = {
        criteria: ["Agent completes task"],
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      agent.invokeLLM = async () => {
        return mockLLMResult("continue_test", {});
      };

      const result = await agent.call(createBaseInput());
      expect(result).toBeNull();
    });
  });

  describe("when discovery exhausts max steps without terminal tool", () => {
    let largeTrace: ReadableSpan[];
    let collector: JudgeSpanCollector;

    beforeEach(() => {
      largeTrace = createLargeTrace();
      collector = createMockSpanCollector(largeTrace);
      for (const span of largeTrace) {
        (span.attributes as Record<string, unknown>)["langwatch.thread.id"] =
          "test-thread";
      }
    });

    it("forces a verdict instead of hard-failing", async () => {
      const config: JudgeAgentConfig = {
        criteria: ["Agent works correctly"],
        spanCollector: collector,
        maxDiscoverySteps: 3,
      };

      const agent = judgeAgent(config);

      let callCount = 0;
      agent.invokeLLM = async (params) => {
        callCount++;
        if (callCount === 1) {
          // First call: AI SDK multi-step loop returns only discovery tool calls
          // (simulates exhaustion — no terminal tool found)
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
              {
                toolName: "grep_trace",
                input: { pattern: "test" },
                type: "tool-call" as const,
                toolCallId: "tc-2",
              },
            ],
            toolResults: [],
          } as unknown as InvokeLLMResult;
        }
        // Second call: forced verdict
        expect(params.toolChoice).toEqual({
          type: "tool",
          toolName: "finish_test",
        });
        expect(params.stopWhen).toBeUndefined();
        // Check that force-verdict message was appended
        const lastMsg = params.messages?.[params.messages.length - 1];
        expect(lastMsg).toBeDefined();
        expect(
          typeof lastMsg!.content === "string"
            ? lastMsg!.content
            : ""
        ).toContain("maximum");

        return mockLLMResult("finish_test", {
          criteria: { agent_works_correctly: "true" },
          reasoning: "Based on gathered info, agent works",
          verdict: "success",
        });
      };

      const result = await agent.call(createBaseInput());

      expect(callCount).toBe(2);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.reasoning).toBe("Based on gathered info, agent works");
    });

    it("forced verdict can return failure", async () => {
      const config: JudgeAgentConfig = {
        criteria: ["Agent uses tools", "Agent responds politely"],
        spanCollector: collector,
        maxDiscoverySteps: 2,
      };

      const agent = judgeAgent(config);

      let callCount = 0;
      agent.invokeLLM = async () => {
        callCount++;
        if (callCount === 1) {
          // Discovery exhausted — only expand_trace calls
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
        }
        return mockLLMResult("finish_test", {
          criteria: {
            agent_uses_tools: "false",
            agent_responds_politely: "true",
          },
          reasoning: "Agent was polite but did not use any tools",
          verdict: "failure",
        });
      };

      const result = await agent.call(createBaseInput());

      expect(callCount).toBe(2);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.metCriteria).toContain("Agent responds politely");
      expect(result!.unmetCriteria).toContain("Agent uses tools");
    });

    it("strips discovery tools and rewrites history before forced verdict", async () => {
      const config: JudgeAgentConfig = {
        criteria: ["Agent works correctly"],
        spanCollector: collector,
        maxDiscoverySteps: 2,
      };

      const agent = judgeAgent(config);

      let forcedParams: InvokeLLMParams | undefined;
      let callCount = 0;
      agent.invokeLLM = async (params) => {
        callCount++;
        if (callCount === 1) {
          // Simulate a real multi-step loop: last step emits a discovery tool
          // and the accumulated history carries the matching tool_use /
          // tool_result pair that would normally trip up a stripped call.
          const prevMessages = params.messages ?? [];
          params.messages = [
            ...prevMessages,
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: "tc-1",
                  toolName: "expand_trace",
                  input: { span_ids: ["deadbeef00000000"] },
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result" as const,
                  toolCallId: "tc-1",
                  toolName: "expand_trace",
                  output: { type: "text", value: "span details here" },
                },
              ],
            },
          ] as any;
          return {
            text: "",
            content: [],
            toolCalls: [
              {
                toolName: "grep_trace",
                input: { pattern: "error" },
                type: "tool-call" as const,
                toolCallId: "tc-2",
              },
            ],
            toolResults: [],
          } as unknown as InvokeLLMResult;
        }
        forcedParams = params;
        return mockLLMResult("finish_test", {
          criteria: { agent_works_correctly: "true" },
          reasoning: "ok",
          verdict: "success",
        });
      };

      const result = await agent.call(createBaseInput());

      expect(callCount).toBe(2);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);

      // forceVerdict must have stripped expand_trace and grep_trace from the
      // tool set, leaving only the terminal tools.
      const toolNames = Object.keys(forcedParams!.tools ?? {});
      expect(toolNames).not.toContain("expand_trace");
      expect(toolNames).not.toContain("grep_trace");
      expect(toolNames).toContain("finish_test");

      // Message history must have been rewritten: no assistant message
      // should still contain a tool-call part for a discovery tool, and no
      // tool-role message should remain.
      const msgs = forcedParams!.messages ?? [];
      for (const m of msgs) {
        expect(m.role).not.toBe("tool");
        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const part of m.content as Array<Record<string, unknown>>) {
            expect(part.type).not.toBe("tool-call");
          }
        }
      }

      // The recap text should carry forward what the discovery tool returned
      // so the model can still reason about it.
      const recapHit = msgs.some(
        (m) =>
          m.role === "assistant" &&
          typeof m.content === "string" &&
          m.content.includes("expand_trace") &&
          m.content.includes("span details here")
      );
      expect(recapHit).toBe(true);
    });

    it("skips forceVerdict when an earlier step already emitted finish_test", async () => {
      const config: JudgeAgentConfig = {
        criteria: ["Agent works correctly"],
        spanCollector: collector,
        maxDiscoverySteps: 3,
      };

      const agent = judgeAgent(config);

      let callCount = 0;
      agent.invokeLLM = async () => {
        callCount++;
        // AI SDK v6 surfaces only the last step in `toolCalls`, but an
        // earlier step did emit finish_test. discoveryExhausted should
        // spot it via `steps` and skip the force path.
        return {
          text: "",
          content: [],
          toolCalls: [
            {
              toolName: "expand_trace",
              input: { span_ids: ["0000000000000000"] },
              type: "tool-call" as const,
              toolCallId: "tc-last",
            },
          ],
          toolResults: [],
          steps: [
            {
              toolCalls: [
                {
                  toolName: "expand_trace",
                  input: { span_ids: ["0000000000000000"] },
                  type: "tool-call" as const,
                  toolCallId: "tc-first",
                },
              ],
            },
            {
              toolCalls: [
                {
                  toolName: "finish_test",
                  input: {
                    criteria: { agent_works_correctly: "true" },
                    reasoning: "converged early",
                    verdict: "success",
                  },
                  type: "tool-call" as const,
                  toolCallId: "tc-finish",
                },
              ],
            },
            {
              toolCalls: [
                {
                  toolName: "expand_trace",
                  input: { span_ids: ["0000000000000000"] },
                  type: "tool-call" as const,
                  toolCallId: "tc-last",
                },
              ],
            },
          ],
        } as unknown as InvokeLLMResult;
      };

      await agent.call(createBaseInput());
      // Only one LLM call — forceVerdict must not have fired.
      expect(callCount).toBe(1);
    });

    it("returns inconclusive when forceVerdict still leaks a discovery tool", async () => {
      const config: JudgeAgentConfig = {
        criteria: ["Agent works correctly"],
        spanCollector: collector,
        maxDiscoverySteps: 2,
      };

      const agent = judgeAgent(config);

      agent.invokeLLM = async () => {
        // Simulate both the exhausted discovery loop and a forceVerdict
        // response where the model ignored tool_choice and still returned
        // only a discovery tool.
        return {
          text: "",
          content: [],
          toolCalls: [
            {
              toolName: "grep_trace",
              input: { pattern: "anything" },
              type: "tool-call" as const,
              toolCallId: "tc-leak",
            },
          ],
          toolResults: [],
        } as unknown as InvokeLLMResult;
      };

      const result = await agent.call(createBaseInput());

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.reasoning).not.toContain("Unknown tool call");
      expect(result!.reasoning).toContain("did not converge");
      expect(result!.unmetCriteria).toContain("Agent works correctly");
    });
  });

  describe("additional context via judgmentRequest.context", () => {
    it("includes <additional_context> in the user message when context is provided", async () => {
      const collector = createMockSpanCollector([]);

      const config: JudgeAgentConfig = {
        criteria: ["Agent installed the dependency"],
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("finish_test", {
          criteria: { agent_installed_the_dependency: "true" },
          reasoning: "npm install exited 0",
          verdict: "success",
        });
      };

      const inputWithContext = createBaseInput({
        judgmentRequest: {
          context:
            "The agent ran `npm install -g git-orchard` which exited 0. The binary is now at /usr/local/bin/orchard.",
        },
      });

      await agent.call(inputWithContext);

      expect(capturedParams).toBeDefined();
      const messages = capturedParams!.messages ?? [];
      const userMessage = messages.find((m) => m.role === "user");
      if (!userMessage) throw new Error("Expected a user message in LLM call");
      const userContent =
        typeof userMessage.content === "string"
          ? userMessage.content
          : JSON.stringify(userMessage.content);
      expect(userContent).toContain("<additional_context>");
      expect(userContent).toContain("npm install -g git-orchard");
      expect(userContent).toContain("</additional_context>");
    });

    it("omits <additional_context> when no context is provided", async () => {
      const collector = createMockSpanCollector([]);

      const config: JudgeAgentConfig = {
        criteria: ["Agent responded"],
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("finish_test", {
          criteria: { agent_responded: "true" },
          reasoning: "ok",
          verdict: "success",
        });
      };

      await agent.call(createBaseInput());

      expect(capturedParams).toBeDefined();
      const messages = capturedParams!.messages ?? [];
      const userMessage = messages.find((m) => m.role === "user");
      if (!userMessage) throw new Error("Expected a user message in LLM call");
      const userContent =
        typeof userMessage.content === "string"
          ? userMessage.content
          : JSON.stringify(userMessage.content);
      expect(userContent).not.toContain("<additional_context>");
    });
  });

  describe("when no criteria provided and judgment requested", () => {
    it("returns failure with 'No criteria' reasoning without calling the LLM", async () => {
      // Reproduces issue #184: judge must short-circuit and not call the LLM
      // when enforcement is requested (judgmentRequest != null) but the agent
      // has no criteria to evaluate against.
      const collector = createMockSpanCollector([]);

      const config: JudgeAgentConfig = {
        criteria: [],
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      let llmCalled = false;
      agent.invokeLLM = async () => {
        llmCalled = true;
        return mockLLMResult("finish_test", {
          criteria: {},
          reasoning: "ok",
          verdict: "success",
        });
      };

      const result = await agent.call(
        createBaseInput({ judgmentRequest: {} })
      );

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.reasoning).toContain("No criteria");
      expect(result!.metCriteria).toEqual([]);
      expect(result!.unmetCriteria).toEqual([]);
      // Must not have called the LLM — this is a fast early return.
      expect(llmCalled).toBe(false);
    });

    it("uses inline criteria from judgmentRequest when provided", async () => {
      // If judgmentRequest carries its own criteria, the judge should use those
      // instead of its own (empty) list and NOT short-circuit.
      const smallTrace = createSmallTrace();
      const collector = createMockSpanCollector(smallTrace);
      for (const span of smallTrace) {
        (span.attributes as Record<string, unknown>)["langwatch.thread.id"] = "test-thread";
      }

      const config: JudgeAgentConfig = {
        criteria: [],          // agent has no criteria of its own
        spanCollector: collector,
      };

      const agent = judgeAgent(config);

      let capturedParams: InvokeLLMParams | undefined;
      agent.invokeLLM = async (params) => {
        capturedParams = params;
        return mockLLMResult("finish_test", {
          criteria: { inline_criterion: "true" },
          reasoning: "passed",
          verdict: "success",
        });
      };

      const result = await agent.call(
        createBaseInput({
          judgmentRequest: { criteria: ["Inline criterion"] },
        })
      );

      expect(capturedParams).toBeDefined();   // LLM was called
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.metCriteria).toContain("Inline criterion");
    });
  });
});
