import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { trace, context } from "@opentelemetry/api";
import { generateText, stepCountIs, tool } from "ai";
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";

/**
 * Span-Based Evaluation Example
 *
 * Demonstrates how the judge evaluates internal agent operations via spans:
 * - Custom span tracking (HTTP calls, database queries)
 * - Model usage verification
 * - Tool execution visibility
 *
 * The judge sees the full execution trace, not just the conversation.
 */

const tracer = trace.getTracer("order-processing-agent");

/** Simulated inventory check tool */
const checkInventoryTool = tool({
  description: "Check if an item is in stock",
  inputSchema: z.object({
    productId: z.string().describe("The product ID to check"),
  }),
  execute: async ({ productId }) => {
    await new Promise((r) => setTimeout(r, 50));
    return { inStock: true, quantity: 42, productId };
  },
});

/**
 * Agent that creates observable custom spans during execution.
 */
const observableAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const parentSpan = trace.getActiveSpan();
    const parentContext = parentSpan
      ? trace.setSpan(context.active(), parentSpan)
      : context.active();

    return context.with(parentContext, async () => {
      // Custom span: HTTP call to fraud detection service
      const fraudCheckSpan = tracer.startSpan("http.fraud_check", {
        attributes: {
          "http.method": "POST",
          "http.url": "https://api.fraudservice.com/check",
          "http.status_code": 200,
        },
      });
      await new Promise((r) => setTimeout(r, 30));
      fraudCheckSpan.setAttribute("fraud.risk_score", 0.1);
      fraudCheckSpan.end();

      // Custom span: Database query
      const dbSpan = tracer.startSpan("db.query", {
        attributes: {
          "db.system": "postgresql",
          "db.operation": "SELECT",
          "db.statement": "SELECT * FROM customers WHERE id = $1",
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      dbSpan.end();

      // LLM call with tool usage
      const response = await generateText({
        model: openai("gpt-5-mini"),
        messages: [
          {
            role: "system",
            content: `You are an order processing assistant.
When asked about products, use the check_inventory tool.`,
          },
          ...input.messages,
        ],
        tools: { check_inventory: checkInventoryTool },
        experimental_telemetry: { isEnabled: true },
        stopWhen: stepCountIs(2),
      });

      return response.text;
    });
  },
};

describe("Span-Based Evaluation", () => {
  it("should verify custom spans and tool calls via judge", async () => {
    const result = await scenario.run({
      name: "span-based evaluation demo",
      description: `
        A customer asks about product SKU-123 availability.
        The agent should check inventory and respond.
      `,
      agents: [
        observableAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent(),
      ],
      script: [
        scenario.user("Is product SKU-123 in stock?"),
        scenario.agent(),
        scenario.judge({
          criteria: [
            "A fraud check HTTP call was made (http.fraud_check span exists)",
            "A database query was performed (db.query span exists)",
            "The check_inventory tool was called for the product",
          ],
        }),
      ],
      maxTurns: 5,
    });

    console.log(result);
    expect(result.success).toBe(true);
  });
});
