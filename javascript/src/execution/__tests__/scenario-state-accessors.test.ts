// Ref: specs/scenario-state-accessors.feature
import { describe, expect, it } from "vitest";
import { messagesWithToolCall, span, stateWith, SQL_INPUT, type StampedMessage } from "./state-fixture";

const secondCallSpan = span({
  name: "run_sql",
  attributes: {
    "langwatch.span.type": "tool",
    "langwatch.input": '{"sql":"SELECT 1"}',
    "langwatch.output": "[[1]]",
  },
  traceId: "trace-1",
  startMs: 200,
});

describe("scenario state accessors", () => {
  describe("given the scenario declares the field golden_sql", () => {
    // Scenario: The state exposes the scenario fields
    const state = stateWith({ fields: { golden_sql: "SELECT 1", limit: 0, strict: false, blank: "" } });

    it("exposes the fields and reads one by name", () => {
      expect(state.fields).toEqual({ golden_sql: "SELECT 1", limit: 0, strict: false, blank: "" });
      expect(state.field("golden_sql")).toBe("SELECT 1");
    });

    it("returns nothing for a field the scenario does not set or leaves blank", () => {
      expect(state.field("missing")).toBeUndefined();
      expect(state.field("blank")).toBeUndefined();
    });

    it("keeps zero and false as values", () => {
      expect(state.field("limit")).toBe(0);
      expect(state.field("strict")).toBe(false);
    });
  });

  describe("given a judge with two criteria", () => {
    // Scenario: The state exposes the judge criteria
    it("lists both in order", () => {
      const state = stateWith({ criteria: ["Reports the count", "Names the quarter"] });
      expect(state.criteria).toEqual(["Reports the count", "Names the quarter"]);
    });
  });

  describe("given a user message, an assistant tool call and an assistant answer", () => {
    // Scenario: The state renders the conversation
    const state = stateWith({ messages: messagesWithToolCall });

    it("renders the first user message, the last agent message and the transcript", () => {
      expect(state.firstUserMessage()).toBe("How many chargebacks last quarter?");
      expect(state.lastAgentMessage().content).toBe("There were 12 chargebacks.");
      const transcript = state.transcript();
      expect(transcript.split("\n")[0]).toBe("user: How many chargebacks last quarter?");
      expect(transcript).toContain("run_sql");
      expect(transcript.split("\n").at(-1)).toBe("assistant: There were 12 chargebacks.");
    });
  });

  describe("given a run_sql call in the messages and a second one in the spans", () => {
    // Scenario: Tool calls merge the messages and the spans in start order
    const state = stateWith({ messages: messagesWithToolCall, spans: [secondCallSpan] });

    it("lists both calls, the message call first, each with its name, input, output, turn and source", () => {
      const calls = state.toolCalls("run_sql");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({
        name: "run_sql",
        input: SQL_INPUT,
        output: { type: "json", value: { count: 12 } },
        turn: 0,
        source: "message",
      });
      expect(calls[1]).toEqual({
        name: "run_sql",
        input: '{"sql":"SELECT 1"}',
        output: "[[1]]",
        turn: 0,
        source: "span",
      });
    });

    // Scenario: A tool call collection picks with first and last
    it("picks with first and last and lists the inputs and outputs of three calls", () => {
      const thirdCallSpan = span({
        name: "run_sql",
        attributes: {
          "langwatch.span.type": "tool",
          "langwatch.input": '{"sql":"SELECT 2"}',
          "langwatch.output": "[[2]]",
        },
        traceId: "trace-1",
        startMs: 300,
      });
      const calls = stateWith({
        messages: messagesWithToolCall,
        spans: [thirdCallSpan, secondCallSpan],
      }).toolCalls("run_sql");
      expect(calls).toHaveLength(3);
      expect(calls.first?.input).toEqual(SQL_INPUT);
      expect(calls.last?.input).toBe('{"sql":"SELECT 2"}');
      expect(calls.inputs).toEqual([SQL_INPUT, '{"sql":"SELECT 1"}', '{"sql":"SELECT 2"}']);
      expect(calls.outputs).toEqual([{ type: "json", value: { count: 12 } }, "[[1]]", "[[2]]"]);
      expect([...calls].map((call) => call.source)).toEqual(["message", "span", "span"]);
      expect(calls[2]?.input).toBe('{"sql":"SELECT 2"}');
    });

    it("lists every tool call without a name", () => {
      expect(state.toolCalls().map((call) => call.name)).toEqual(["run_sql", "run_sql"]);
    });
  });

  describe("given a span that describes the message tool call", () => {
    // Scenario: A span that describes a message tool call is not listed twice
    it("lists one call", () => {
      const twin = span({
        name: "run_sql",
        attributes: {
          "langwatch.span.type": "tool",
          "gen_ai.tool.name": "run_sql",
          "langwatch.input": JSON.stringify(SQL_INPUT),
        },
        traceId: "trace-1",
      });
      const state = stateWith({ messages: messagesWithToolCall, spans: [twin] });
      expect(state.toolCalls("run_sql")).toHaveLength(1);
      expect(state.toolCalls("run_sql").first?.source).toBe("message");
    });
  });

  describe("given no run_sql call", () => {
    // Scenario: An empty tool call collection has no pick
    it("has no pick, no inputs and counts zero", () => {
      const calls = stateWith({ messages: [{ role: "assistant", content: "Done." }] }).toolCalls("run_sql");
      expect(calls.first).toBeUndefined();
      expect(calls.last).toBeUndefined();
      expect(calls.inputs).toEqual([]);
      expect(calls.outputs).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  describe("given the collector holds spans of this trace out of order", () => {
    // Scenario: The state exposes the spans of the run so far
    it("lists them in start order without fetching", () => {
      const late = span({ name: "late", attributes: {}, startMs: 300 });
      const early = span({ name: "early", attributes: {}, startMs: 100 });
      const state = stateWith({ spans: [late, early] });
      expect(state.spans.map((s) => s.name)).toEqual(["early", "late"]);
    });
  });

  describe("given a rag span with two documents", () => {
    // Scenario: The state exposes the retrieved contexts
    it("lists both document contents", () => {
      const state = stateWith({
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
      expect(state.contexts).toEqual(["Table chargebacks", "plain text"]);
    });

    it("is empty without rag spans", () => {
      expect(stateWith().contexts).toEqual([]);
    });
  });

  describe("given messages of two turns with two trace ids and spans of both", () => {
    const messages: StampedMessage[] = [
      ...messagesWithToolCall,
      { role: "user", content: "And per merchant?", traceId: "trace-2", turn: 2 },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_2", toolName: "run_sql", input: { sql: "SELECT merchant" } },
        ],
        traceId: "trace-2",
        turn: 2,
      },
      { role: "assistant", content: "Here they are.", traceId: "trace-2", turn: 2 },
    ];
    const spans = [
      span({ name: "turn two", attributes: {}, traceId: "trace-2", startMs: 500 }),
      secondCallSpan,
      span({ name: "turn one", attributes: {}, traceId: "trace-1", startMs: 100 }),
    ];
    const state = stateWith({ messages, spans });

    // Scenario: The state groups spans by trace
    it("lists the traces in the order the messages saw them, each with its spans and tool calls", () => {
      const traces = state.traces;
      expect(traces.map((trace) => trace.id)).toEqual(["trace-1", "trace-2"]);
      expect(traces[0].spans.map((s) => s.name)).toEqual(["turn one", "run_sql"]);
      expect(traces[1].spans.map((s) => s.name)).toEqual(["turn two"]);
      expect(traces[0].toolCalls("run_sql").inputs).toEqual([SQL_INPUT, '{"sql":"SELECT 1"}']);
      expect(traces[1].toolCalls("run_sql").inputs).toEqual([{ sql: "SELECT merchant" }]);
    });

    // Scenario: The state groups messages by turn
    it("lists the turns with their index, messages, trace and tool calls", () => {
      const turns = state.turns;
      expect(turns.map((turn) => turn.index)).toEqual([0, 1]);
      expect(turns[0].messages).toHaveLength(4);
      expect(turns[1].messages).toHaveLength(3);
      expect(turns[0].trace?.id).toBe("trace-1");
      expect(turns[1].trace?.id).toBe("trace-2");
      expect(turns[1].toolCalls("run_sql").first?.input).toEqual({ sql: "SELECT merchant" });
      expect(state.toolCalls("run_sql").map((call) => call.turn)).toEqual([0, 0, 1]);
    });
  });
});
