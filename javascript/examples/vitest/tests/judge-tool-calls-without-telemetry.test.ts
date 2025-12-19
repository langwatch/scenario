import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

/**
 * Judge Tool Calls Without Telemetry
 *
 * This example demonstrates how the judge can evaluate tool calls
 * even when you don't have OpenTelemetry enabled.
 *
 * The key: return tool-call and tool-result messages from your agent
 * so they become part of the conversation history the judge sees.
 */

const getWeatherMock = vi.fn();

const getWeatherTool = tool({
  description: "Get the current weather for a city",
  inputSchema: z.object({
    city: z.string(),
  }),
  execute: getWeatherMock,
});

/**
 * Agent that returns tool messages in the conversation.
 *
 * By returning tool-call and tool-result messages, the judge
 * can see exactly what tools were called and what they returned,
 * without needing OpenTelemetry tracing.
 *
 * To see an example of using telemetry, see the span-based-evaluation.test.ts.
 * To see an example using state assertions in the script, see the tool-failure-simulation.test.ts.
 */
const weatherAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const response = await generateText({
      model: openai("gpt-4o"),
      messages: input.messages,
      tools: { get_weather: getWeatherTool },
      toolChoice: "auto",
    });

    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCall = response.toolCalls[0];
      const result = await getWeatherMock(toolCall.input);

      // Return tool messages so judge can see them
      return [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              input: toolCall.input,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              output: { type: "text", value: JSON.stringify(result) },
            },
          ],
        },
      ];
    }

    return response.text;
  },
};

describe("Judge Tool Calls Without Telemetry", () => {
  it("judge evaluates tool calls from conversation history", async () => {
    getWeatherMock.mockResolvedValue({ temp: 22, condition: "sunny" });

    const result = await scenario.run({
      name: "weather tool evaluation",
      description: "Judge evaluates tool calls without telemetry",
      agents: [
        weatherAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "The agent called the get_weather tool with city 'Paris'",
            "The tool returned weather data",
          ],
        }),
      ],
      script: [
        scenario.user("What's the weather in Paris?"),
        scenario.agent(),
        scenario.judge(),
      ],
    });

    expect(result.success).toBe(true);
  });
});
