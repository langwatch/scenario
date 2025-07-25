import { openai } from "@ai-sdk/openai";
import scenario, {
  type AgentAdapter,
  AgentReturnTypes,
  AgentRole,
} from "@langwatch/scenario";
import { CoreMessage, generateText, tool } from "ai";
import { describe, it, expect } from "vitest";
import { z } from "zod";

// Define the weather tool using zod for parameters
const getCurrentWeather = tool({
  description: "Get the current weather in a given city.",
  parameters: z.object({
    city: z.string().describe("The city to get the weather for."),
    date_range: z.string().describe("The date range to get the weather for."),
  }),
  execute: async ({
    city,
    date_range,
  }: {
    city: string;
    date_range: string;
  }) => {
    // Simulate weather
    const choices = ["sunny", "cloudy", "rainy", "snowy"];
    const temperature = Math.floor(Math.random() * 31);
    const weather = choices[Math.floor(Math.random() * choices.length)];
    return `The weather in ${city} is ${weather} with a temperature of ${temperature}°C.`;
  },
});

const getAccomodation = tool({
  description: "Get the accomodation in a given city.",
  parameters: z.object({
    city: z.string().describe("The city to get the accomodation for."),
    weather: z.string().describe("The weather in the city."),
  }),
  execute: async ({ city, weather }: { city: string; weather: string }) => {
    if (weather === "sunny") {
      return [
        "Water Park Inn - $100 per night",
        "Beach Resort La Playa - $150 per night",
        "Hotelito - $200 per night",
      ];
    }

    if (weather === "cloudy" || weather === "rainy") {
      return [
        "Hotel Barcelona - $100 per night",
        "Hotel Rome - $150 per night",
        "Hotel Venice - $200 per night",
      ];
    }

    if (weather === "snowy") {
      return [
        "Mountains Peak Lodge - $100 per night",
        "Snowy Mountain Inn - $150 per night",
        "Snowy Mountain Resort - $200 per night",
      ];
    }

    throw new Error(`Invalid weather: ${weather}`);
  },
});

const callTravelAgent = async (
  messages: CoreMessage[],
  responseMessages: CoreMessage[] = []
): Promise<AgentReturnTypes> => {
  const response = await generateText({
    model: openai("gpt-4.1"),
    messages: [
      {
        role: "system",
        content: `
            You are a helpful assistant that may help the user with weather information.
            Do not guess the city if they don't provide it.
            You can make multiple tool calls if they ask multiple cities.

            Today is Friday, 25th July 2025.
          `,
      },
      ...messages,
      ...responseMessages,
    ],
    tools: {
      get_current_weather: getCurrentWeather,
      get_accomodation: getAccomodation,
    },
    toolChoice: "auto",
    temperature: 0.0,
  });

  if (response.toolCalls && response.toolCalls.length > 0) {
    const toolCall = response.toolCalls[0];
    // Agent executes the tool directly and returns both messages
    const toolResult = await getCurrentWeather.execute(toolCall.args, {
      toolCallId: toolCall.toolCallId,
      messages: messages,
    });
    return callTravelAgent(messages, [
      ...responseMessages,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            args: toolCall.args,
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
            result: toolResult,
          },
        ],
      },
    ]);
  }

  return [
    ...responseMessages,
    {
      role: "assistant",
      content: response.text,
    },
  ];
};

const travelAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    return callTravelAgent(input.messages);
  },
};

describe("Travel Agent", () => {
  it("should provide the weather and accomodation options based on it", async () => {
    const result = await scenario.run({
      name: "boat trip travel planning",
      description: `
        The user is planning a boat trip from Barcelona to Rome,
        and is wondering what the weather will be like.

        The user will ask for different accomodation options
        depending on the weather.
      `,
      agents: [
        travelAgent,
        scenario.userSimulatorAgent({ model: openai("gpt-4.1") }),
        scenario.judgeAgent({
          model: openai("gpt-4.1"),
          criteria: [
            "The agent should ask which city is the user asking accomodations for if they don't provide it.",
            "The agent should share the prices of each accomodation for the user to consider.",
            "The agent should not bias the user towards a specific accomodation.",
          ],
        }),
      ],
      script: [
        scenario.user(),
        scenario.agent(),
        (state) => expect(state.hasToolCall("get_current_weather2")).toBe(true),
        scenario.user(),
        scenario.agent(),
        scenario.user(),
        scenario.agent(),
        (state) => expect(state.hasToolCall("get_accomodation")).toBe(true),
        scenario.judge(),
      ],
      setId: "javascript-examples",
    });
    expect(result.success).toBe(true);
  });
});
