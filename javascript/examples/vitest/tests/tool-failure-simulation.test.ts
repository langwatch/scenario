import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

// Mock the external service tool
const callExternalServiceMock = vi.fn();

// Define a tool that can fail
const callExternalServiceTool = tool({
  description: "Call an external service",
  inputSchema: z.object({
    endpoint: z.string().describe("The service endpoint to call"),
  }),
  execute: callExternalServiceMock,
});

const resilientAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    try {
      const response = await generateText({
        model: openai("gpt-4o"),
        messages: input.messages,
        tools: { call_external_service: callExternalServiceTool },
        toolChoice: "auto",
      });
      return response.text;
    } catch (error) {
      return `I encountered an error: ${
        error instanceof Error ? error.message : "Unknown error"
      }. Let me try a different approach.`;
    }
  },
};

describe("Tool Failure Simulation", () => {
  it("should handle tool timeout errors", async () => {
    // Simulate tool timeout
    callExternalServiceMock.mockRejectedValue(new Error("Request timeout"));

    const result = await scenario.run({
      name: "tool timeout test",
      description: "Test agent's ability to handle tool timeouts",
      agents: [resilientAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Call the external service"),
        scenario.agent(),
        (state) => {
          expect(callExternalServiceMock).toHaveBeenCalled();
          // Agent should handle the error gracefully
          const response = state.lastAgentMessage().content;
          expect(response).toContain("error");
        },
        scenario.succeed(),
      ],
    });

    expect(result.success).toBe(true);
  });

  it("should handle tool rate limit errors", async () => {
    // Simulate rate limit error
    callExternalServiceMock.mockRejectedValue(new Error("Rate limit exceeded"));

    const result = await scenario.run({
      name: "tool rate limit test",
      description: "Test agent's ability to handle rate limits",
      agents: [resilientAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Call the external service"),
        scenario.agent(),
        (state) => {
          expect(callExternalServiceMock).toHaveBeenCalled();
          const response = state.lastAgentMessage().content;
          expect(response).toContain("error");
        },
        scenario.succeed(),
      ],
    });

    expect(result.success).toBe(true);
  });

  it("should handle successful tool calls", async () => {
    // Simulate successful tool call
    callExternalServiceMock.mockResolvedValue("Service call successful");

    const result = await scenario.run({
      name: "tool success test",
      description: "Test agent's ability to handle successful tool calls",
      agents: [resilientAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Call the external service"),
        scenario.agent(),
        (state) => {
          expect(callExternalServiceMock).toHaveBeenCalled();
        },
        scenario.succeed(),
      ],
    });

    expect(result.success).toBe(true);
  });
});

