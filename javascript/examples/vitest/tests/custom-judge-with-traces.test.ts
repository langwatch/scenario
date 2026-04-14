/**
 * Example test demonstrating a custom judge that accesses OpenTelemetry traces.
 *
 * This example shows how to build a judge that inspects the agent's OTel spans
 * to verify specific tool calls were made. The judge uses `grepTrace` to search
 * through collected spans for evidence of tool usage, giving you visibility into
 * the agent's internal behavior beyond just its text responses.
 */

import { openai } from "@ai-sdk/openai";
import scenario, {
  type AgentInput,
  type AgentReturnTypes,
  AgentAdapter,
  AgentRole,
  judgeSpanCollector,
  grepTrace,
} from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

class ToolVerifyingJudge extends AgentAdapter {
  role = AgentRole.JUDGE;
  requiredTool: string;

  constructor(requiredTool: string) {
    super();
    this.requiredTool = requiredTool;
  }

  async call(input: AgentInput): Promise<AgentReturnTypes> {
    if (!input.judgmentRequest) {
      return null;
    }

    // Collect all spans recorded for this scenario thread
    const spans = judgeSpanCollector.getSpansForThread(input.threadId);

    // Search the spans for evidence of the required tool call
    const result = grepTrace(spans, this.requiredTool);

    if (result.includes("No matches found") || result.includes("No spans recorded")) {
      return {
        success: false,
        reasoning: `Tool '${this.requiredTool}' was not found in the trace. Grep result: ${result}`,
        metCriteria: [],
        unmetCriteria: [`Agent must call the '${this.requiredTool}' tool`],
      };
    }

    return {
      success: true,
      reasoning: `Tool '${this.requiredTool}' was found in the trace. Grep result: ${result}`,
      metCriteria: [`Agent must call the '${this.requiredTool}' tool`],
      unmetCriteria: [],
    };
  }
}

const simpleAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "Sure! Let me look that up for you. The weather today is sunny and 72F.";
  },
};

describe("Custom Judge with Traces", () => {
  it("verifies tool usage via OpenTelemetry trace inspection", async () => {
    const result = await scenario.run({
      name: "trace-aware judge",
      description:
        "User asks for weather and expects the agent to use a weather tool",
      agents: [
        simpleAgent,
        scenario.userSimulatorAgent({ model: openai("gpt-5-mini") }),
        new ToolVerifyingJudge("weather_lookup"),
      ],
      script: [
        scenario.user("What's the weather like today?"),
        scenario.agent(),
        scenario.judge(),
      ],
    });

    // The simple agent does not emit tool call spans, so the judge
    // correctly reports that the required tool was not found.
    expect(result.success).toBe(false);
    expect(result.reasoning).toContain("weather_lookup");
  });
});
