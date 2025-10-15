import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

/**
 * API Service Mocking Example (Level 2)
 *
 * This example demonstrates Level 2 mocking: mocking HTTP calls within tools.
 * Unlike Level 1 (mocking the tool function), here we mock at the service layer.
 *
 * When to use this:
 * - You want to test the tool's implementation (not just the agent's tool usage)
 * - You need to simulate different API responses (errors, timeouts, etc.)
 * - You're testing integration with third-party services
 *
 * Key concepts:
 * - Mock the service/API client within the tool
 * - Tool implementation stays real - only the service call is mocked
 * - Tests both agent reasoning AND tool implementation
 */

// Mock an API client that tools will use
const apiClient = {
  getUser: vi.fn(),
};

// Real tool implementation - uses the API client
// We'll mock the API client, not the tool itself
const fetchUserDataTool = tool({
  description: "Fetch user data from external API",
  inputSchema: z.object({
    userId: z.string().describe("The user ID to fetch data for"),
  }),
  execute: async ({ userId }) => {
    // This calls our API client which we'll mock
    const data = await apiClient.getUser(userId);
    return data;
  },
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

describe("API Service Mocking", () => {
  it("should mock API calls within tools", async () => {
    // Mock the API client's response
    // This simulates what the real API would return
    apiClient.getUser.mockResolvedValue({
      id: "123",
      name: "Alice",
      email: "alice@example.com",
    });

    const result = await scenario.run({
      name: "api service test",
      description: "Test tool's API integration",
      agents: [userDataAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Get user data for ID 123"),
        scenario.agent(),
        (_state) => {
          // Verify the API client was called with correct ID
          // This tests both the agent AND the tool implementation
          expect(apiClient.getUser).toHaveBeenCalledWith("123");
        },
        scenario.succeed(),
      ],
    });

    expect(result.success).toBe(true);
  });
});
