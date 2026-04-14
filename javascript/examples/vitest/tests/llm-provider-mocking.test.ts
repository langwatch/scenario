import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, ToolSet, GenerateTextResult } from "ai";
import { describe, it, expect, vi } from "vitest";

/**
 * LLM Provider Mocking Example
 *
 * This example shows how to mock the LLM provider itself for testing agent flow
 * without making actual LLM API calls.
 *
 * ⚠️  Note: For most use cases, Scenario's caching system is a better solution.
 * Caching gives you deterministic responses while still testing your actual
 * LLM integration code. Use this pattern only when you need complete control
 * over the LLM's responses or when testing offline.
 *
 * Key concepts:
 * - Mock generateText to return predetermined responses
 * - Test conversation flow without LLM costs
 * - Useful for CI/CD pipelines or offline development
 * - Consider using Scenario's cache instead for most cases
 */

// Mock the generateText function from the AI SDK
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    generateText: vi.fn(), // Replace with mock
  };
});

const mockGenerateText = vi.mocked(generateText);

const chatAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    // This generateText call will be intercepted by our mock
    const response = await generateText({
      model: openai("gpt-5-mini"),
      messages: input.messages,
      experimental_telemetry: { isEnabled: true },
    });
    return response.text;
  },
};

describe("LLM Provider Mocking", () => {
  it("should mock LLM responses", async () => {
    // Configure the mock to return a predetermined response
    // No actual LLM call will be made
    mockGenerateText.mockResolvedValue({
      text: "I can help you with that request.",
    } as GenerateTextResult<ToolSet, unknown>);

    const result = await scenario.run({
      name: "llm mock test",
      description: "Test with mocked LLM responses",
      agents: [chatAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Hello"),
        scenario.agent(),
        (state) => {
          // Verify the mock was called (proving generateText was invoked)
          expect(mockGenerateText).toHaveBeenCalled();
          // Verify the predetermined response was used
          expect(state.lastAgentMessage().content).toBe(
            "I can help you with that request."
          );
        },
        scenario.succeed(),
      ],
    });

    expect(result.success).toBe(true);
  });
});
