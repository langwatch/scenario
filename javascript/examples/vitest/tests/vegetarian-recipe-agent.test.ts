import { openai } from "@ai-sdk/openai";
import * as scenario from "@langwatch/scenario";
import { generateText } from "ai";
import { describe, it, expect } from "vitest";

describe("Vegetarian Recipe Agent", () => {
  const agent: scenario.AgentAdapter = {
    role: scenario.AgentRole.AGENT,
    call: async (input) => {
      const response = await generateText({
        model: openai("gpt-4.1-mini"),
        messages: [
          {
            role: "system",
            content: `You are a vegetarian recipe agent.\nGiven the user request, ask AT MOST ONE follow-up question, then provide a complete recipe. Keep your responses concise and focused.`,
          },
          ...input.messages,
        ],
      });
      return response.text;
    },
  };

  it("should generate a vegetarian recipe for a hungry and tired user on a Saturday evening", async () => {
    const result = await scenario.run({
      name: "dinner idea",
      description: `It's saturday evening, the user is very hungry and tired, but have no money to order out, so they are looking for a recipe.`,
      agents: [
        agent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          model: openai("gpt-4.1-mini"),
          criteria: [
            "Agent should not ask more than two follow-up questions",
            "Agent should generate a recipe",
            "Recipe should include a list of ingredients",
            "Recipe should include step-by-step cooking instructions",
            "Recipe should be vegetarian and not include any sort of meat",
          ],
        }),
      ],
    });
    expect(result.success).toBe(true);
  });
});
