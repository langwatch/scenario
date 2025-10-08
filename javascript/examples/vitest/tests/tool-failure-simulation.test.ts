import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

/**
 * Tool Failure Simulation Example
 *
 * This example demonstrates how to test agents that handle tool failures gracefully.
 * Key concepts:
 * - Manual tool execution for explicit error control
 * - Catching tool errors before they crash the agent
 * - Returning errors as tool results so the LLM can inform the user
 * - Testing both failure and success paths
 */

// Mock the external service function - we'll control its behavior in tests
const callExternalServiceMock = vi.fn();

// Define the tool that agents will use
const callExternalServiceTool = tool({
  description: "Call an external service API endpoint",
  inputSchema: z.object({
    endpoint: z.string(),
  }),
  execute: callExternalServiceMock,
});

/**
 * Agent that handles tool failures gracefully.
 *
 * Why manual tool execution?
 * - Explicit control over error handling
 * - Can catch errors and format them for the LLM
 * - Ensures conversation continues even when tools fail
 * - Production-ready pattern for resilient agents
 */
const resilientAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    // First LLM call - agent decides if/how to use tools
    const response = await generateText({
      model: openai("gpt-4o"),
      messages: input.messages,
      tools: { call_external_service: callExternalServiceTool },
      toolChoice: "auto",
    });

    // Check if the LLM decided to call any tools
    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCall = response.toolCalls[0];

      let toolResultContent: string;
      try {
        // Execute the tool - this is where errors can occur
        const result = await callExternalServiceMock(toolCall.input);
        toolResultContent = String(result);
      } catch (error) {
        // Catch the error and format it as a tool result
        // The LLM will see this error and can inform the user appropriately
        toolResultContent = `Error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
      }

      // Return the tool call and result as messages
      // This keeps the conversation going with error context
      return [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              input: toolCall.input,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              output: { type: "text", value: toolResultContent },
            },
          ],
        },
      ];
    }

    // No tools called - return the LLM's direct response
    return response.text;
  },
};

describe("Tool Failure Simulation", () => {
  it("should handle tool failures gracefully", async () => {
    // Configure the mock to simulate a tool failure
    // In production, this could be a timeout, rate limit, network error, etc.
    callExternalServiceMock.mockRejectedValue(new Error("Request timeout"));

    const result = await scenario.run({
      name: "tool failure test",
      description: "Test that agent handles tool failures without crashing",
      agents: [resilientAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Call the service at /api/data"),
        scenario.agent(),
        (state) => {
          // Verify the tool was called (proving the LLM decided to use it)
          expect(callExternalServiceMock).toHaveBeenCalled();
          // Verify the error was captured as a tool result (not thrown)
          expect(state.hasToolCall("call_external_service")).toBe(true);
        },
        scenario.succeed(),
      ],
    });

    // The test passes because the agent handled the error gracefully
    // The conversation continued instead of crashing
    expect(result.success).toBe(true);
  });

  it("should handle successful tool calls", async () => {
    // Configure the mock to simulate successful tool execution
    callExternalServiceMock.mockResolvedValue("Success");

    const result = await scenario.run({
      name: "tool success test",
      description: "Test that agent handles successful tool calls",
      agents: [resilientAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Call the service at /api/data"),
        scenario.agent(),
        (state) => {
          // Verify the tool was called successfully
          expect(callExternalServiceMock).toHaveBeenCalled();
          expect(state.hasToolCall("call_external_service")).toBe(true);
        },
        scenario.succeed(),
      ],
    });

    expect(result.success).toBe(true);
  });
});
