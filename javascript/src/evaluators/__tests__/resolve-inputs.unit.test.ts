// Ref: specs/scenario-evaluators.feature
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { ModelMessage } from "ai";
import { describe, it, expect } from "vitest";
import { conversation, field, scenarioSource, trace, value } from "../mappings";
import { resolveInput, type EvaluatorInputContext } from "../resolve-inputs";

function span({
  name,
  attributes,
}: {
  name: string;
  attributes: Record<string, unknown>;
}): ReadableSpan {
  return { name, attributes } as unknown as ReadableSpan;
}

const messagesWithToolCall: ModelMessage[] = [
  { role: "user", content: "How many chargebacks last quarter?" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "run_sql",
        input: { sql: "SELECT count(*) FROM chargebacks" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "run_sql",
        output: { type: "json", value: { count: 12 } },
      },
    ],
  },
  { role: "assistant", content: "There were 12 chargebacks." },
];

function contextOf(overrides: Partial<EvaluatorInputContext>): EvaluatorInputContext {
  return {
    messages: [],
    description: "A fraud analyst asks for chargebacks.",
    criteria: ["Reports the count", "Names the quarter"],
    fields: {},
    spans: [],
    ...overrides,
  };
}

describe("evaluator input resolution", () => {
  describe("given the agent returned a run_sql tool call in its messages", () => {
    // Scenario: A tool call input resolves from the message tool calls
    const context = contextOf({ messages: messagesWithToolCall });

    it("resolves the tool call input to the arguments of the last call", () => {
      const resolved = resolveInput({
        mapping: trace.toolCall("run_sql").input,
        context,
      });
      expect(resolved).toEqual({
        kind: "value",
        value: { sql: "SELECT count(*) FROM chargebacks" },
      });
    });

    it("resolves the tool call output to the matching tool result", () => {
      const resolved = resolveInput({
        mapping: trace.toolCall("run_sql").output,
        context,
      });
      expect(resolved).toEqual({
        kind: "value",
        value: { type: "json", value: { count: 12 } },
      });
    });

    it("resolves the conversation sources", () => {
      expect(
        resolveInput({ mapping: conversation.firstUserMessage, context })
      ).toEqual({ kind: "value", value: "How many chargebacks last quarter?" });
      expect(
        resolveInput({ mapping: conversation.lastAgentMessage, context })
      ).toEqual({ kind: "value", value: "There were 12 chargebacks." });
      const transcript = resolveInput({ mapping: conversation.transcript, context });
      expect(transcript.kind).toBe("value");
      expect(String((transcript as { value: string }).value)).toContain(
        "user: How many chargebacks last quarter?"
      );
      expect(String((transcript as { value: string }).value)).toContain("run_sql");
    });
  });

  describe("given the messages carry no tool call but the trace holds a tool span", () => {
    // Scenario: A tool call resolves from the trace spans when the messages carry none
    const context = contextOf({
      messages: [{ role: "assistant", content: "Done." }],
      spans: [
        span({
          name: "run_sql",
          attributes: {
            "langwatch.span.type": "tool",
            "langwatch.input": '{"sql":"SELECT 1"}',
            "langwatch.output": "[[1]]",
          },
        }),
        span({
          name: "llm call",
          attributes: { "langwatch.span.type": "llm" },
        }),
      ],
    });

    it("resolves the tool call input from the span", () => {
      expect(
        resolveInput({ mapping: trace.toolCall("run_sql").input, context })
      ).toEqual({ kind: "value", value: '{"sql":"SELECT 1"}' });
    });

    it("resolves the tool call output from the span", () => {
      expect(
        resolveInput({ mapping: trace.toolCall("run_sql").output, context })
      ).toEqual({ kind: "value", value: "[[1]]" });
    });
  });

  describe("given neither the messages nor the trace carry the tool call", () => {
    // Scenario: A missing tool call fails the evaluator with a reason
    it("fails with the reason and asks for the trace", () => {
      expect(
        resolveInput({
          mapping: trace.toolCall("run_sql").input,
          context: contextOf({ messages: [{ role: "assistant", content: "Done." }] }),
        })
      ).toEqual({
        kind: "failed",
        reason: "no run_sql call in the trace",
        needsTrace: true,
      });
    });
  });

  describe("given the scenario fields", () => {
    // Scenario: A blank field skips the evaluator with a reason
    it("skips a field the scenario does not set", () => {
      expect(
        resolveInput({ mapping: field("golden_sql"), context: contextOf({}) })
      ).toEqual({ kind: "skipped", reason: "no golden_sql on this scenario" });
    });

    it("skips a field the scenario left blank", () => {
      expect(
        resolveInput({
          mapping: field("golden_sql"),
          context: contextOf({ fields: { golden_sql: "" } }),
        })
      ).toEqual({ kind: "skipped", reason: "no golden_sql on this scenario" });
    });

    it("resolves a set field to its value", () => {
      expect(
        resolveInput({
          mapping: field("golden_sql"),
          context: contextOf({ fields: { golden_sql: "SELECT 1" } }),
        })
      ).toEqual({ kind: "value", value: "SELECT 1" });
    });
  });

  describe("given the scenario definition sources", () => {
    it("resolves the situation and the criteria", () => {
      const context = contextOf({});
      expect(resolveInput({ mapping: scenarioSource.situation, context })).toEqual({
        kind: "value",
        value: "A fraud analyst asks for chargebacks.",
      });
      expect(resolveInput({ mapping: scenarioSource.criteria, context })).toEqual({
        kind: "value",
        value: "Reports the count\nNames the quarter",
      });
    });

    it("resolves a literal value", () => {
      expect(resolveInput({ mapping: value("x"), context: contextOf({}) })).toEqual({
        kind: "value",
        value: "x",
      });
    });
  });

  describe("given rag spans in the trace", () => {
    it("resolves the contexts to the retrieved documents", () => {
      const context = contextOf({
        spans: [
          span({
            name: "retrieve",
            attributes: {
              "langwatch.span.type": "rag",
              "langwatch.rag_contexts": JSON.stringify([
                { document_id: "a", content: "Table chargebacks" },
                "plain text",
              ]),
            },
          }),
        ],
      });
      expect(resolveInput({ mapping: trace.contexts, context })).toEqual({
        kind: "value",
        value: ["Table chargebacks", "plain text"],
      });
    });

    it("fails with a reason when the trace holds no contexts", () => {
      expect(resolveInput({ mapping: trace.contexts, context: contextOf({}) })).toEqual({
        kind: "failed",
        reason: "no retrieved contexts in the trace",
        needsTrace: true,
      });
    });
  });
});
