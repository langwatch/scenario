import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

// Mock the database tool functions
const saveUserMock = vi.fn();
const findUserMock = vi.fn();

// Define database tools
const saveUserTool = tool({
  description: "Save a user to the database",
  inputSchema: z.object({
    name: z.string().describe("The user's name"),
    email: z.string().describe("The user's email"),
  }),
  execute: saveUserMock,
});

const findUserTool = tool({
  description: "Find users by name",
  inputSchema: z.object({
    name: z.string().describe("The name to search for"),
  }),
  execute: findUserMock,
});

const databaseAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
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
          expect(saveUserMock).toHaveBeenCalledWith({
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
