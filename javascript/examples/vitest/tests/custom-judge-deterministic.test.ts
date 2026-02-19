/**
 * Example test demonstrating a fully custom deterministic judge.
 *
 * This example shows how to build a judge that uses programmatic checks instead
 * of LLM calls. Fast, cheap, and fully deterministic — useful for verifying
 * tool usage, message structure, or any condition you can check mechanically.
 */

import { openai } from "@ai-sdk/openai";
import scenario, {
  type AgentInput,
  type AgentReturnTypes,
  AgentAdapter,
  AgentRole,
  type JudgeResult,
} from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

class ToolCallJudge extends AgentAdapter {
  role = AgentRole.JUDGE;
  criteria: string[];
  requiredTools: string[];

  constructor(requiredTools: string[]) {
    super();
    this.requiredTools = requiredTools;
    this.criteria = requiredTools.map((t) => `Agent calls ${t}`);
  }

  async call(input: AgentInput): Promise<AgentReturnTypes> {
    if (!input.judgmentRequest) {
      return null; // Not asked to judge yet, continue
    }

    const calledTools = new Set<string>();
    for (const msg of input.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            typeof part === "object" &&
            "type" in part &&
            part.type === "tool-call"
          ) {
            calledTools.add((part as { toolName: string }).toolName);
          }
        }
      }
    }

    const passed = this.requiredTools.filter((t) => calledTools.has(t));
    const failed = this.requiredTools.filter((t) => !calledTools.has(t));

    return {
      success: failed.length === 0,
      reasoning:
        failed.length > 0
          ? `Called: ${passed}. Missing: ${failed}.`
          : `All required tools called: ${passed}`,
      metCriteria: passed.map((t) => `Agent calls ${t}`),
      unmetCriteria: failed.map((t) => `Agent calls ${t}`),
    };
  }
}

const fakeWeatherAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "get_weather",
            toolCallId: "call_1",
            args: { city: "Barcelona" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "get_weather",
            toolCallId: "call_1",
            result: "Sunny, 24C",
          },
        ],
      },
      {
        role: "assistant",
        content: "It's sunny and 24C in Barcelona!",
      },
    ];
  },
};

describe("Custom Deterministic Judge", () => {
  it("passes when the required tool is called", async () => {
    const result = await scenario.run({
      name: "deterministic judge - tool called",
      description: "User asks about the weather",
      agents: [
        fakeWeatherAgent,
        scenario.userSimulatorAgent({ model: openai("gpt-4o-mini") }),
        new ToolCallJudge(["get_weather"]),
      ],
      script: [
        scenario.user("What's the weather in Barcelona?"),
        scenario.agent(),
        scenario.judge(),
      ],
    });

    expect(result.success).toBe(true);
    expect(result.metCriteria).toContain("Agent calls get_weather");
  });

  it("fails when a required tool is missing", async () => {
    const result = await scenario.run({
      name: "deterministic judge - tool missing",
      description: "User asks about the weather",
      agents: [
        fakeWeatherAgent,
        scenario.userSimulatorAgent({ model: openai("gpt-4o-mini") }),
        new ToolCallJudge(["get_weather", "get_forecast"]),
      ],
      script: [
        scenario.user("What's the weather in Barcelona?"),
        scenario.agent(),
        scenario.judge(),
      ],
    });

    expect(result.success).toBe(false);
    expect(result.metCriteria).toContain("Agent calls get_weather");
    expect(result.unmetCriteria).toContain("Agent calls get_forecast");
  });
});
