import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

const lightningFastAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 1)); // Simulate lightning fast response time
    return {
      role: "assistant",
      content: `response to ${input.messages[input.messages.length - 1].content}`,
    };
  },
};

describe("Lightning Fast Agent", () => {
  Array(10)
    .fill(0)
    .forEach((_, i) =>
    it(`fast agent test #${i + 1}`, async () => {
      const result = await scenario.run({
        name: `fast agent test #${i + 1}`,
        description: `
          This test checks the performance of a lightning fast agent.
        `,
        agents: [
          lightningFastAgent,
          scenario.userSimulatorAgent({ model: openai("gpt-5-mini") }),
        ],
        script: [
          scenario.user("foo"),
          scenario.agent(),
          scenario.user("bar"),
          scenario.agent(),
          scenario.succeed(),
        ],
        setId: "javascript-examples",
      });
      expect(result.success).toBe(true);
    })
  );
});
