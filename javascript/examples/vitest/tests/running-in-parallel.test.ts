import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText } from "ai";
import { describe, it, expect } from "vitest";

describe("Vegetarian Recipe Agent (Parallel)", () => {
  const agent: AgentAdapter = {
    role: AgentRole.AGENT,
    call: async (input) => {
      const response = await generateText({
        model: openai("gpt-4.1-mini"),
        messages: [
          {
            role: "system",
            content: `You are a vegetarian recipe agent. When a user asks for a recipe,
            <rules>
              - You may ask ONLY ONE clarifying question if absolutely necessary (like dietary restrictions or cooking time preference), but then you MUST provide a complete vegetarian recipe.
              - Do not ask multiple follow-up questions.
            </rules>`,
          },
          ...input.messages,
        ],
      });
      return response.text;
    },
  };

  it("should generate a vegetarian recipe for a standard dinner idea", async () => {
    const result = await scenario.run({
      name: "dinner idea",
      description: "User is looking for a dinner idea",
      agents: [
        agent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "Recipe agent generates a vegetarian recipe",
            "Recipe includes a list of ingredients",
            "Recipe includes step-by-step cooking instructions",
            "The recipe is vegetarian and does not include meat",
            "The agent should NOT ask more than two follow-up questions",
          ],
        }),
      ],
      maxTurns: 5,
      setId: "javascript-examples",
    });

    try {
      expect(result.success).toBe(true);
    } catch (error) {
      console.log(result);
      throw error;
    }
  });

  it("should generate a vegetarian recipe for a very hungry user", async () => {
    const result = await scenario.run({
      name: "hungry user",
      description: "User is very very hungry, they say they could eat a cow",
      agents: [
        agent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "Recipe agent generates a vegetarian recipe",
            "Recipe includes a list of ingredients",
            "Recipe includes step-by-step cooking instructions",
            "The recipe is vegetarian and does not include meat",
            "The agent should NOT ask more than two follow-up questions",
          ],
        }),
      ],
      maxTurns: 5,
      setId: "javascript-examples",
    });

    try {
      expect(result.success).toBe(true);
    } catch (error) {
      console.log(result);
      throw error;
    }
  });
});
