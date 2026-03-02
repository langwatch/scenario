import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText } from "ai";
import { describe, it, expect } from "vitest";

const assistant: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const response = await generateText({
      model: openai("gpt-4.1-nano"),
      messages: [
        {
          role: "system",
          content:
            "You are a helpful travel planning assistant. Help users plan trips, suggest destinations, provide packing tips, and answer travel questions. Be concise.",
        },
        ...input.messages,
      ],
    });
    return response.text;
  },
};

describe("10-turn scripted multiturn conversation", () => {
  it("should handle a full 10-turn travel planning conversation", async () => {
    const result = await scenario.run({
      name: "10-turn travel planning",
      description:
        "A user plans a week-long trip to Japan, asking about destinations, weather, packing, food, transport, budget, etiquette, connectivity, safety, and a final summary.",
      agents: [
        assistant,
        scenario.userSimulatorAgent({ model: anthropic("claude-opus-4-6") }),
        scenario.judgeAgent({
          criteria: [
            "Agent answered all 10 user questions relevantly",
            "Agent provided specific and helpful travel advice about Japan",
            "Agent maintained context across the full conversation",
          ],
        }),
      ],
      script: [
        // Turn 1
        scenario.user("i want to plan a week trip to japan, where should i go"),
        scenario.agent(),
        // Turn 2
        scenario.user("what's the weather like in tokyo in april"),
        scenario.agent(),
        // Turn 3
        scenario.user("what should i pack for that weather"),
        scenario.agent(),
        // Turn 4
        scenario.user("any must-try food in tokyo"),
        scenario.agent(),
        // Turn 5
        scenario.user("how do i get around the city, trains or taxi"),
        scenario.agent(),
        // Turn 6
        scenario.user("what's a reasonable daily budget in usd"),
        scenario.agent(),
        // Turn 7
        scenario.user("any cultural etiquette i should know about"),
        scenario.agent(),
        // Turn 8
        scenario.user("do i need a sim card or will wifi be enough"),
        scenario.agent(),
        // Turn 9
        scenario.user("is it safe for solo travelers"),
        scenario.agent(),
        // Turn 10
        scenario.user("can you give me a quick day by day itinerary for 7 days"),
        scenario.agent(),
        // Judge
        scenario.judge(),
      ],
      setId: "javascript-examples",
    });

    expect(result.success).toBe(true);
  });
});
