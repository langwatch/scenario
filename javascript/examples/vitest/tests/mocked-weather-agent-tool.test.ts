import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";

// Define the weather tool using zod for parameters
const getCurrentWeather = tool({
  description: "Get the current weather in a given city.",
  inputSchema: z.object({
    city: z.string().describe("The city to get the weather for."),
  }),
  execute: async ({ city }: { city: string }) => {
    // Simulate weather
    const choices = ["sunny", "cloudy", "rainy", "snowy"];
    const temperature = Math.floor(Math.random() * 31);
    const weather = choices[Math.floor(Math.random() * choices.length)];
    return `The weather in ${city} is ${weather} with a temperature of ${temperature}°C.`;
  },
});

describe("Mocked Weather Agent Tool", () => {
  it("should mock a tool call and result", async () => {
    const agent = (): AgentAdapter => ({
      role: AgentRole.AGENT,
      call: async (input) => {
        const response = await generateText({
          model: openai("gpt-4.1-nano"),
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

        return response.text;
      },
    });

    const result = await scenario.run({
      name: "mocked checking the weather",
      description: `
        The user is planning a boat trip from Barcelona to Rome,
        and is wondering what the weather will be like.
      `,
      agents: [agent(), scenario.userSimulatorAgent()],
      script: [
        scenario.message({
          role: "user",
          content: "What's the weather in Paris?",
        }),
        scenario.message({
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "get_current_weather",
              toolCallId: "call_123",
              input: { city: "Paris" },
            },
          ],
        }),
        scenario.message({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "get_current_weather",
              toolCallId: "call_123",
              output: { type: "text", value: "The weather in Paris is sunny and 75°F." },
            },
          ],
        }),
        scenario.agent(), // Agent processes the tool result
        scenario.succeed(),
      ],
      setId: "javascript-examples",
    });
    expect(result.success).toBe(true);
  });
});
