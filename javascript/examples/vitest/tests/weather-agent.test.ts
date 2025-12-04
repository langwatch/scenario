import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool, ToolCallPart } from "ai";
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";

// Define the weather tool using zod for parameters
const getCurrentWeather = tool({
  description: "Get the current weather in a given city.",
  inputSchema: z.object({
    city: z.string().describe("The city to get the weather for."),
  }),
  execute: async ({ city }: { city: string }): Promise<string> => {
    // Simulate weather
    const choices = ["sunny", "cloudy", "rainy", "snowy"];
    const temperature = Math.floor(Math.random() * 31);
    const weather = choices[Math.floor(Math.random() * choices.length)];
    return `The weather in ${city} is ${weather} with a temperature of ${temperature}°C.`;
  },
});

const weatherAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const response = await generateText({
      model: openai("gpt-4.1"),
      messages: [
        {
          role: "system",
          content: `
            You are a helpful assistant that may help the user with weather information.
            Do not guess the city if they don't provide it.
          `,
        },
        ...input.messages,
      ],
      tools: { get_current_weather: getCurrentWeather },
      toolChoice: "auto",
    });

    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCall = response.toolCalls[0];
      // Agent executes the tool directly and returns both messages
      const toolResult = await getCurrentWeather.execute(
        toolCall.input as { city: string },
        {
          toolCallId: toolCall.toolCallId,
          messages: input.messages,
        }
      );
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
              output: { type: "text", value: toolResult as string },
            },
          ],
        },
      ];
    }

    return {
      role: "assistant",
      content: response.text,
    };
  },
};

describe("Weather Agent", () => {
  it("should call the get_current_weather tool in the scenario", async () => {
    const result = await scenario.run({
      name: "checking the weather",
      description: `
        The user is planning a boat trip from Barcelona to Rome today,
        and is wondering what the weather will be like.
      `,
      agents: [
        weatherAgent,
        scenario.userSimulatorAgent({ model: openai("gpt-4.1") }),
      ],
      script: [
        scenario.user(),
        scenario.agent(),
        (state) => expect(state.hasToolCall("get_current_weather")).toBe(true),
        (state) => {
          const assistantMessage = state.lastAgentMessage();
          const assistantMessageContent = assistantMessage
            .content[0] as ToolCallPart;
          const toolCallResult = state.lastToolCall("get_current_weather");

          expect(toolCallResult.content[0].toolName).toBe(
            "get_current_weather"
          );
          expect(toolCallResult.content[0].output.value).toContain("Barcelona");

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          expect((assistantMessageContent.input as any).city).toBe("Barcelona");
        },
        scenario.succeed(),
      ],
      setId: "javascript-examples",
    });
    expect(result.success).toBe(true);
  });
});
