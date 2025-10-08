import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

/**
 * Database Tool Mocking Example
 *
 * This example shows how to mock multiple tools that interact with databases.
 * Perfect for testing agents that perform CRUD operations without needing
 * a real database.
 *
 * Key concepts:
 * - Mock multiple tools in one agent
 * - Test database operations (save, find, update, delete)
 * - Verify correct parameters are passed to database tools
 * - No actual database required for testing
 */

// Mock the database operation functions
const saveUserMock = vi.fn();
const findUserMock = vi.fn();

// Define database tools - these would normally interact with a real database
const saveUserTool = tool({
  description: "Save a user to the database",
  inputSchema: z.object({
    name: z.string().describe("The user's name"),
    email: z.string().describe("The user's email"),
  }),
  execute: saveUserMock, // Mock instead of real database call
});

const findUserTool = tool({
  description: "Find users by name",
  inputSchema: z.object({
    name: z.string().describe("The name to search for"),
  }),
  execute: findUserMock, // Mock instead of real database query
});

const databaseAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    // Agent has access to multiple database tools
    const response = await generateText({
      model: openai("gpt-4o"),
      messages: input.messages,
      tools: {
        save_user: saveUserTool,
        find_user: findUserTool,
      },
      toolChoice: "auto",
    });
    return response.text;
  },
};

describe("Database Tool Mocking", () => {
  it("should mock save user tool", async () => {
    // Configure what the mock database save should return
    saveUserMock.mockResolvedValue({
      id: 123,
      name: "John",
      email: "john@example.com",
    });

    const result = await scenario.run({
      name: "database save test",
      description: "Test agent's ability to save user data via tool",
      agents: [databaseAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Save a new user named John with email john@example.com"),
        scenario.agent(),
        (state) => {
          // Verify the agent called save_user with correct parameters
          // The agent should have extracted the name and email from the user's message
          expect(saveUserMock).toHaveBeenCalled();
          const [params] = saveUserMock.mock.calls[0];
          expect(params).toEqual({
            name: "John",
            email: "john@example.com",
          });
        },
        scenario.succeed(),
      ],
    });

    expect(result.success).toBe(true);
  });
});
