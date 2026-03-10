import { anthropic } from "@ai-sdk/anthropic";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

/**
 * Reproduces the "assistant message prefill" error with Claude.
 * The agent returns array content (multi-part), which skips role reversal
 * in the user simulator, causing the conversation to end with an assistant message.
 */
const agentWithArrayContent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async () => {
    // Return array content like the real-world case
    return {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "" },
        {
          type: "text" as const,
          text: "Absolutely—happy to help. To get started, I'll need either the data or access details. Could you upload a CSV/Excel export, or share your database connection details?",
        },
      ],
    };
  },
};

describe("Reproduce: assistant message prefill error", () => {
  it.skipIf(!process.env.ANTHROPIC_API_KEY)("should fail when agent returns array content and user simulator is Claude", async () => {
    const result = await scenario.run({
      name: "prefill error repro",
      description: "User asks for help analyzing sales data, agent responds with array content",
      agents: [
        agentWithArrayContent,
        scenario.userSimulatorAgent({ model: anthropic("claude-opus-4-6") }),
        scenario.judgeAgent({ criteria: ["Agent responded helpfully"] }),
      ],
      script: [
        scenario.user("hey can you help me analyze some sales data trends from last quarter"),
        scenario.agent(),
        scenario.user(),
        scenario.agent(),
        scenario.succeed(),
      ],
      setId: "javascript-examples",
    });

    expect(result.success).toBe(true);
  });
});
