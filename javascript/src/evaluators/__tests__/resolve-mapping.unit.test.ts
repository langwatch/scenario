// Ref: specs/scenario-evaluators.feature
import { describe, expect, it } from "vitest";
import {
  messagesWithToolCall,
  span,
  stateWith,
  SQL_INPUT,
  type StampedMessage,
} from "../../execution/__tests__/state-fixture";
import { conversation, field, scenarioSource, trace, value } from "../mappings";
import { resolveMapping } from "../resolve-mapping";

describe("evaluator mapping resolution", () => {
  describe("given a mapping that is a function of the state", () => {
    const state = stateWith({ messages: messagesWithToolCall, fields: { golden_sql: "SELECT 1" } });

    // Scenario: A mapping is a function of the scenario state
    it("calls the function with the state and keeps what it returns", async () => {
      let seen: unknown;
      const resolved = await resolveMapping({
        mapping: (s) => {
          seen = s;
          return s.field("golden_sql");
        },
        state,
      });
      expect(seen).toBe(state);
      expect(resolved).toEqual({ kind: "value", value: "SELECT 1" });
    });

    // Scenario: An async mapping is awaited
    it("awaits an async function", async () => {
      const resolved = await resolveMapping({
        mapping: async (s) => s.firstUserMessage(),
        state,
      });
      expect(resolved).toEqual({ kind: "value", value: "How many chargebacks last quarter?" });
    });

    // Scenario: A literal mapping is a constant
    it("keeps a literal as it is", async () => {
      expect(await resolveMapping({ mapping: "en", state })).toEqual({ kind: "value", value: "en" });
      expect(await resolveMapping({ mapping: 3, state })).toEqual({ kind: "value", value: 3 });
      expect(await resolveMapping({ mapping: false, state })).toEqual({ kind: "value", value: false });
    });

    // Scenario: A mapping that raises errors the evaluator
    it("reports what the function threw", async () => {
      const resolved = await resolveMapping({
        mapping: () => {
          throw new Error("boom");
        },
        state,
      });
      expect(resolved.kind).toBe("error");
      expect((resolved as { error: Error }).error.message).toBe("boom");
    });
  });

  describe("given the declarative helpers", () => {
    // Scenario: The declarative helpers are state callables
    const state = stateWith({
      messages: messagesWithToolCall,
      fields: { golden_sql: "SELECT 1" },
      criteria: ["Reports the count", "Names the quarter"],
    });

    it("names the expression each helper stands for", () => {
      expect(conversation.firstUserMessage.expression).toBe("state.firstUserMessage() || undefined");
      expect(field("golden_sql").expression).toBe('state.field("golden_sql")');
      expect(trace.toolCalls("run_sql").last.input.expression).toBe(
        'state.toolCalls("run_sql").last?.input'
      );
      expect(trace.contexts.expression).toBe("state.contexts");
      expect(value("42").expression).toBe('"42"');
    });

    it("gives the same value as the expression", async () => {
      expect(conversation.firstUserMessage(state)).toBe(state.firstUserMessage());
      expect(conversation.lastAgentMessage(state)).toBe("There were 12 chargebacks.");
      expect(conversation.transcript(state)).toBe(state.transcript());
      expect(conversation.messages(state)).toBe(state.messages);
      expect(scenarioSource.situation(state)).toBe(state.description);
      expect(scenarioSource.criteria(state)).toBe("Reports the count\nNames the quarter");
      expect(field("golden_sql")(state)).toBe("SELECT 1");
      expect(trace.toolCalls("run_sql").last.input(state)).toEqual(SQL_INPUT);
      expect(trace.toolCalls("run_sql").last.output(state)).toEqual({ type: "json", value: { count: 12 } });
      expect(trace.toolCalls("run_sql").inputs(state)).toEqual([SQL_INPUT]);
      expect(value("x")(state)).toBe("x");
    });
  });

  describe("given the agent called run_sql twice", () => {
    // Scenario: A tool call pick names the call with first or last
    const messages: StampedMessage[] = [
      ...messagesWithToolCall,
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_2", toolName: "run_sql", input: { sql: "SELECT 2" } }],
        traceId: "trace-2",
        turn: 2,
      },
    ];
    const state = stateWith({ messages });

    it("reads the second call with last and the first with first", async () => {
      expect(await resolveMapping({ mapping: trace.toolCalls("run_sql").last.input, state })).toEqual({
        kind: "value",
        value: { sql: "SELECT 2" },
      });
      expect(await resolveMapping({ mapping: trace.toolCalls("run_sql").first.input, state })).toEqual({
        kind: "value",
        value: SQL_INPUT,
      });
    });

    // Scenario: A turn narrows the tool calls
    it("narrows the calls to one turn", async () => {
      expect(
        await resolveMapping({ mapping: (s) => s.turns[1].toolCalls("run_sql").inputs, state })
      ).toEqual({ kind: "value", value: [{ sql: "SELECT 2" }] });
    });
  });

  describe("given the messages carry no tool call but the trace holds a tool span", () => {
    // Scenario: A tool call resolves from the trace spans when the messages carry none
    it("reads the span", async () => {
      const state = stateWith({
        messages: [{ role: "assistant", content: "Done.", traceId: "trace-1" }],
        spans: [
          span({
            name: "run_sql",
            attributes: {
              "langwatch.span.type": "tool",
              "langwatch.input": '{"sql":"SELECT 1"}',
              "langwatch.output": "[[1]]",
            },
          }),
        ],
      });
      expect(await resolveMapping({ mapping: trace.toolCalls("run_sql").last.input, state })).toEqual({
        kind: "value",
        value: '{"sql":"SELECT 1"}',
      });
      expect(await resolveMapping({ mapping: trace.toolCalls("run_sql").last.output, state })).toEqual({
        kind: "value",
        value: "[[1]]",
      });
    });
  });

  describe("given a mapping that finds nothing", () => {
    const state = stateWith({ messages: [{ role: "assistant", content: "Done.", traceId: "trace-1" }] });

    // Scenario: A mapping that returns nothing skips the evaluator
    it("says the mapping returned nothing and did not read the trace", async () => {
      expect(await resolveMapping({ mapping: () => undefined, state })).toEqual({
        kind: "nothing",
        reason: "the mapping returned nothing",
        readTrace: false,
      });
      expect(await resolveMapping({ mapping: () => [], state })).toMatchObject({ kind: "nothing" });
    });

    // Scenario: A blank field skips the evaluator with the field name
    it("names the blank field", async () => {
      expect(await resolveMapping({ mapping: field("golden_sql"), state })).toEqual({
        kind: "nothing",
        reason: "no golden_sql on this scenario",
        readTrace: false,
      });
      expect(await resolveMapping({ mapping: (s) => s.field("golden_sql"), state })).toMatchObject({
        reason: "no golden_sql on this scenario",
      });
    });

    // Scenario: A missing tool call skips the evaluator with the tool name
    it("names the missing tool call and says the trace was read", async () => {
      expect(await resolveMapping({ mapping: trace.toolCalls("run_sql").last.input, state })).toEqual({
        kind: "nothing",
        reason: "no run_sql call in the trace",
        readTrace: true,
      });
    });

    it("names the missing contexts and says the trace was read", async () => {
      expect(await resolveMapping({ mapping: trace.contexts, state })).toEqual({
        kind: "nothing",
        reason: "no retrieved contexts in the trace",
        readTrace: true,
      });
      expect(await resolveMapping({ mapping: (s) => s.spans.filter(() => false), state })).toEqual({
        kind: "nothing",
        reason: "the mapping returned nothing",
        readTrace: true,
      });
    });
  });
});
