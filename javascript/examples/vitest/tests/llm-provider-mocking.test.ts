import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText } from "ai";
import { describe, it, expect, vi } from "vitest";

// Mock the generateText function
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

const mockGenerateText = vi.mocked(generateText);

const chatAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const response = await generateText({
      model: openai("gpt-4o"),
      messages: input.messages,
    });
    return response.text;
  },
};

describe("LLM Provider Mocking", () => {
  it("should mock LLM responses", async () => {
    // Mock the LLM response
    mockGenerateText.mockResolvedValue({
      text: "I can help you with that request.",
    } as any);

    const result = await scenario.run({
      name: "llm mock test",
      description: "Test with mocked LLM responses",
      agents: [chatAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Hello"),
        scenario.agent(),
        (state) => {
          expect(mockGenerateText).toHaveBeenCalled();
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
