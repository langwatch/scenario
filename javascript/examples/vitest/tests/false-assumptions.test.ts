/**
 * Example test for a simple agent that just echoes back the message.
 *
 * This example demonstrates testing a basic AI agent that just echoes back the message
 * using the `Scenario` and `TestableAgent` interfaces.
 */
import { openai } from "@ai-sdk/openai";
import * as scenario from "@langwatch/scenario";
import { generateText } from "ai";
import { describe, it, expect } from "vitest";

describe("False Assumptions", () => {
  it("tests false assumptions", async () => {
    const agent: scenario.AgentAdapter = {
      role: scenario.AgentRole.AGENT,
      call: async (input) => {
        const response = await generateText({
          model: openai("gpt-4.1-nano"),
          messages: [
            { role: "system", content: "You are a helpful assistant" },
            ...input.messages,
          ],
        });

        return response.text;
      },
    };

    const result = await scenario.run({
      name: "Early assumption bias",
      description: "The agent makes false assumption that the user is talking about an ATM bank, and user corrects it that they actually mean river banks",
      agents: [
        agent,
        scenario.judgeAgent({
          criteria: [
            "user should get good recommendations on river crossing",
            "agent should NOT keep following up about ATM recommendation after user has corrected them that they are actually just hiking",
          ],
        }),
        scenario.userSimulatorAgent(),
      ],
      maxTurns: 10,
      verbose: true,
      script: [
        // Define hardcoded messages
        scenario.agent("Hello, how can I help you today?"),
        scenario.user("how do I safely approach a bank?"),

        // Or let it be generated automatically
        scenario.agent(),

        // Generate a user follow-up message
        scenario.user(),

        // Let the simulation proceed for 2 more turns, print at every turn
        scenario.proceed(
          2,
          (state) => {
            console.log(`Turn ${state.turn}: ${JSON.stringify(state.history)}`);
          }
        ),

        // Time to make a judgment call
        scenario.judge(),
      ],
    });

    expect(result.success).toBe(true);
  });
});
