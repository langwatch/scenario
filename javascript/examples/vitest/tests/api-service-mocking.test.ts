import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

// Mock the fetch function that tools will use
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Real tool implementation that makes HTTP calls
const fetchUserDataTool = tool({
  description: "Fetch user data from external API",
  inputSchema: z.object({
    userId: z.string().describe("The user ID to fetch data for"),
  }),
  execute: async ({ userId }) => {
    const response = await fetch(`https://api.example.com/users/${userId}`);
    const data = await response.json();
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
  it("should mock HTTP calls within tools", async () => {
    // Mock the actual HTTP call
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: "123",
          name: "Alice",
          email: "alice@example.com",
        }),
    });

    const result = await scenario.run({
      name: "api service test",
      description: "Test tool's HTTP integration",
      agents: [userDataAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Get user data for ID 123"),
        scenario.agent(),
        (state) => {
          // Verify the HTTP call was made correctly
          expect(mockFetch).toHaveBeenCalledWith(
            "https://api.example.com/users/123"
          );
        },
        scenario.succeed(),
      ],
    });

    expect(result.success).toBe(true);
  });
});
