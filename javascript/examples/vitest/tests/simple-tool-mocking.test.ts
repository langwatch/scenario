import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

/**
 * Simple Tool Mocking Example
 *
 * This example demonstrates Level 1 mocking: mocking tool execution functions.
 * This is the most common mocking pattern for testing agents.
 *
 * Key concepts:
 * - Mock the tool's execute function to control its behavior
 * - Test that the agent calls tools with correct parameters
 * - Verify agent behavior without hitting real external services
 * - Fast, deterministic tests
 */

// Mock the tool function - we'll control its return value in tests
const fetchUserDataMock = vi.fn();

// Define the tool - the agent will use this to fetch data
const fetchUserDataTool = tool({
  description: "Fetch user data from external API",
  inputSchema: z.object({
    userId: z.string().describe("The user ID to fetch data for"),
  }),
  execute: fetchUserDataMock, // Use the mock instead of real implementation
});

const userDataAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    // Agent uses generateText with tools
    // The AI SDK handles tool execution automatically here
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
    // Configure what the mock should return when called
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
          // Verify the agent called the tool with the correct parameters
          // This proves the agent correctly extracted "123" from the user's message
          expect(fetchUserDataMock).toHaveBeenCalled();
          const [params] = fetchUserDataMock.mock.calls[0];
          expect(params).toEqual({ userId: "123" });
        },
        scenario.succeed(),
      ],
    });

    expect(result.success).toBe(true);
  });
});
