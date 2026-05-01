/**
 * Example test demonstrating a fully custom LLM-based judge.
 *
 * This example shows how to build a judge that calls an LLM directly using
 * the Vercel AI SDK with a Zod schema for structured output. This gives you
 * full control over the prompt, model, and response parsing.
 */

import { openai } from "@ai-sdk/openai";
import scenario, {
  type AgentInput,
  type AgentReturnTypes,
  AgentAdapter,
  AgentRole,
} from "@langwatch/scenario";
import { generateObject } from "ai";
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";

class CustomLLMJudge extends AgentAdapter {
  role = AgentRole.JUDGE;
  criteria: string[];

  constructor(criteria: string[]) {
    super();
    this.criteria = criteria;
  }

  async call(input: AgentInput): Promise<AgentReturnTypes> {
    if (!input.judgmentRequest) {
      return null;
    }

    const criteria = input.judgmentRequest.criteria ?? this.criteria;

    const transcript = input.messages
      .map((m) => {
        if ("content" in m && typeof m.content === "string") {
          return `${m.role}: ${m.content}`;
        }
        return `${m.role}: [tool call]`;
      })
      .join("\n");

    const { object: result } = await generateObject({
      model: openai("gpt-5-mini"),
      schema: z.object({
        pass: z.boolean(),
        reasoning: z.string(),
        results: z.array(
          z.object({
            met: z.boolean(),
          })
        ),
      }),
      prompt: `Evaluate this conversation against the criteria.

Criteria:
${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Conversation:
${transcript}

Return one result per criterion, in the same order as listed above.`,
    });

    const passed = criteria.filter((_, i) => result.results[i]?.met);
    const failed = criteria.filter((_, i) => !result.results[i]?.met);

    return {
      success: result.pass,
      reasoning: result.reasoning,
      metCriteria: passed,
      unmetCriteria: failed,
    };
  }
}

const politeAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "Hello! I'd be happy to help you with that. How can I assist you today?";
  },
};

describe("Custom LLM Judge", () => {
  it("evaluates a polite agent response", async () => {
    const result = await scenario.run({
      name: "custom LLM judge",
      description: "User greets the agent",
      agents: [
        politeAgent,
        scenario.userSimulatorAgent({ model: openai("gpt-5-mini") }),
        new CustomLLMJudge([
          "Agent responds with a greeting",
          "Agent offers to help",
        ]),
      ],
      script: [
        scenario.user("Hi there!"),
        scenario.agent(),
        scenario.judge(),
      ],
    });

    expect(result.success).toBe(true);
    expect(result.metCriteria).toHaveLength(2);
  });
});
