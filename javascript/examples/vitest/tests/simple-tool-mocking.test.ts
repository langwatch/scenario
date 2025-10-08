import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

// Mock the tool function
const fetchUserDataMock = vi.fn();

// Define a tool that uses the mock
const fetchUserDataTool = tool({
  description: "Fetch user data from external API",
  inputSchema: z.object({
    userId: z.string().describe("The user ID to fetch data for"),
  }),
  execute: fetchUserDataMock,
});

const userDataAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const response = await generateText({
      model: openai("gpt-4o"),
      messages: input.messages,
      tools: { fetch_user_data: fetchUserDataTool },
      toolChoice: "auto",
    });
    return response.text;
  },
};

describe("Tool Call Mocking", () => {
  it("should mock tool execution", async () => {
    // Setup mock return value
    fetchUserDataMock.mockResolvedValue({
      name: "Alice",
      points: 150,
      email: "alice@example.com",
    });

    const result = await scenario.run({
      name: "user data tool test",
      description: "Test agent's ability to fetch user data via tool",
      agents: [userDataAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Show me user data for ID 123"),
        scenario.agent(),
        (state) => {
          // Verify the mock was called with correct parameters
          expect(fetchUserDataMock).toHaveBeenCalledWith({ userId: "123" });
        },
        scenario.succeed(),
      ],
    });

    expect(result.success).toBe(true);
  });
});

