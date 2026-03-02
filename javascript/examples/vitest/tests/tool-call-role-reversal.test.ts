import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool } from "ai";
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";

/**
 * Integration test: verifies that tool-call messages from the agent
 * don't get role-reversed to "user" when passed to the user simulator.
 * Both OpenAI and Anthropic reject tool-call content on user messages.
 */

const lookupTool = tool({
  description: "Look up a product by name",
  inputSchema: z.object({
    product: z.string().describe("The product name to look up"),
  }),
  execute: async ({ product }: { product: string }): Promise<string> => {
    return `${product}: $29.99, in stock, ships in 2 days.`;
  },
});

// Agent that always makes a tool call before responding
const toolCallingAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const response = await generateText({
      model: openai("gpt-4o"),
      messages: [
        {
          role: "system",
          content: "You are a helpful shopping assistant. Always use the lookup tool to check product details before responding.",
        },
        ...input.messages,
      ],
      tools: { lookup_product: lookupTool },
      toolChoice: "auto",
    });

    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCall = response.toolCalls[0];
      const toolResult = await lookupTool.execute!(
        toolCall.input as { product: string },
        { toolCallId: toolCall.toolCallId, messages: input.messages }
      );
      return [
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              input: toolCall.input,
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              output: { type: "text" as const, value: toolResult as string },
            },
          ],
        },
      ];
    }

    return { role: "assistant" as const, content: response.text };
  },
};

describe("Tool call role reversal safety", () => {
  it("user simulator (OpenAI gpt-4o) works after agent makes tool calls", async () => {
    const result = await scenario.run({
      name: "tool call then user sim (gpt-4o)",
      description: "User asks about a product, agent uses tool, then user simulator responds",
      agents: [
        toolCallingAgent,
        scenario.userSimulatorAgent({ model: openai("gpt-4o") }),
        scenario.judgeAgent({
          criteria: ["Agent used the lookup tool and provided product info"],
        }),
      ],
      script: [
        scenario.user("do you have wireless headphones in stock?"),
        scenario.agent(),
        scenario.user(), // user simulator must not crash here
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "javascript-examples",
    });

    expect(result.success).toBe(true);
  });
});
