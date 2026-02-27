import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, it, expect } from "vitest";
import { expandTrace, grepTrace } from "../trace-tools";
import { createSpan } from "./helpers/create-span";

function buildSpanSet(): ReadableSpan[] {
  return [
    createSpan({
      spanId: "root",
      name: "agent.run",
      startTime: [1700000000, 0],
      endTime: [1700000002, 0],
      attributes: { "agent.type": "rag" },
    }),
    createSpan({
      spanId: "child-1",
      name: "llm.call",
      parentSpanId: "root",
      startTime: [1700000000, 100_000_000],
      endTime: [1700000000, 500_000_000],
      attributes: {
        "gen_ai.prompt": "What is the weather in Paris?",
        "gen_ai.completion": "Let me check the weather for you.",
        model: "gpt-4",
      },
    }),
    createSpan({
      spanId: "child-2",
      name: "tool.fetch_report",
      parentSpanId: "root",
      startTime: [1700000000, 600_000_000],
      endTime: [1700000000, 900_000_000],
      attributes: {
        "tool.name": "fetch_report",
        "tool.input": '{"city": "Paris"}',
        "tool.output": '{"temp": 22, "condition": "sunny"}',
      },
    }),
    createSpan({
      spanId: "child-3",
      name: "llm.completion",
      parentSpanId: "root",
      startTime: [1700000001, 0],
      endTime: [1700000001, 500_000_000],
      attributes: {
        "gen_ai.prompt": "Summarize the weather report",
        "gen_ai.completion":
          "The weather in Paris is sunny with a temperature of 22 degrees.",
      },
      events: [
        {
          name: "token.generated",
          attributes: { token: "The", index: 0 },
        },
      ],
    }),
    createSpan({
      spanId: "error-span",
      name: "failed.operation",
      parentSpanId: "root",
      startTime: [1700000001, 600_000_000],
      endTime: [1700000001, 700_000_000],
      status: { code: 2, message: "Connection refused" },
      attributes: { "error.type": "NetworkError" },
    }),
  ];
}

describe("expandTrace", () => {
  const spans = buildSpanSet();

  describe("when given a valid single span index", () => {
    it("returns full span details with all attributes and events", () => {
      const result = expandTrace(spans, { index: 2 });
      expect(result).toContain("llm.call");
      expect(result).toContain("gen_ai.prompt");
      expect(result).toContain("What is the weather in Paris?");
      expect(result).toContain("gen_ai.completion");
      expect(result).toContain("gpt-4");
    });

    it("shows the span position in hierarchy", () => {
      // child span should show its tree context
      const result = expandTrace(spans, { index: 2 });
      expect(result).toContain("[2]");
      expect(result).toContain("llm.call");
    });
  });

  describe("when given a valid range", () => {
    it("returns full details for spans in the range", () => {
      const result = expandTrace(spans, { range: "2-3" });
      expect(result).toContain("llm.call");
      expect(result).toContain("tool.fetch_report");
      expect(result).toContain("gen_ai.prompt");
      expect(result).toContain("fetch_report");
    });
  });

  describe("when given an invalid span index", () => {
    it("returns error message with valid range for out-of-bounds index", () => {
      const result = expandTrace(spans, { index: 99 });
      expect(result).toContain("out of range");
      expect(result).toContain("1");
      expect(result).toContain("5");
    });

    it("returns error for index 0", () => {
      const result = expandTrace(spans, { index: 0 });
      expect(result).toContain("out of range");
    });

    it("returns error for negative index", () => {
      const result = expandTrace(spans, { index: -1 });
      expect(result).toContain("out of range");
    });
  });

  describe("when span has events", () => {
    it("includes events in the expanded output", () => {
      const result = expandTrace(spans, { index: 4 });
      expect(result).toContain("token.generated");
      expect(result).toContain("token: The");
    });
  });

  describe("when span has error status", () => {
    it("includes error indicator", () => {
      const result = expandTrace(spans, { index: 5 });
      expect(result).toContain("ERROR");
      expect(result).toContain("Connection refused");
    });
  });

  describe("when result exceeds token budget", () => {
    it("truncates to approximately 4096 tokens and adds truncation note", () => {
      // Create a span with massive content
      const bigSpans = [
        createSpan({
          spanId: "big",
          name: "big.span",
          startTime: [1700000000, 0],
          endTime: [1700000001, 0],
          attributes: {
            "massive.content": "x".repeat(20000),
          },
        }),
      ];
      const result = expandTrace(bigSpans, { index: 1 });
      // 4096 tokens * 4 chars = 16384 chars max
      expect(result.length).toBeLessThanOrEqual(17000); // some slack for truncation note
      expect(result).toContain("[TRUNCATED]");
    });
  });
});

describe("grepTrace", () => {
  const spans = buildSpanSet();

  describe("when pattern matches span attributes", () => {
    it("returns matching spans with tree position headers", () => {
      const result = grepTrace(spans, "fetch_report");
      expect(result).toContain("fetch_report");
      expect(result).toContain("[3]");
      expect(result).toContain("tool.fetch_report");
    });
  });

  describe("when pattern matches content in multiple spans", () => {
    it("returns all matching spans", () => {
      const result = grepTrace(spans, "weather");
      // Should match llm.call (prompt), llm.completion (prompt and completion)
      expect(result).toContain("llm.call");
      expect(result).toContain("llm.completion");
    });
  });

  describe("when pattern is case-insensitive", () => {
    it("finds matches regardless of case", () => {
      const result = grepTrace(spans, "FETCH_REPORT");
      expect(result).toContain("fetch_report");
    });
  });

  describe("when no matches found", () => {
    it("returns no-match message with suggestions from span names", () => {
      const result = grepTrace(spans, "nonexistent_xyz_pattern");
      expect(result).toContain("No matches found");
      // Should suggest span names as alternatives
      expect(result).toContain("agent.run");
    });
  });

  describe("when more than 20 matches exist", () => {
    it("limits to first 20 matches and indicates more exist", () => {
      const manySpans = Array.from({ length: 30 }, (_, i) =>
        createSpan({
          spanId: `span-${i}`,
          name: `operation-${i}`,
          startTime: [1700000000 + i, 0],
          endTime: [1700000000 + i, 100_000_000],
          attributes: { "common.attr": "matching_value" },
        })
      );
      const result = grepTrace(manySpans, "matching_value");
      // Count the number of span headers
      const matchHeaders = result.match(/\[\d+\]/g) ?? [];
      expect(matchHeaders.length).toBeLessThanOrEqual(20);
      expect(result).toContain("more match");
    });
  });

  describe("when grep result exceeds token budget", () => {
    it("truncates total output to approximately 4096 tokens", () => {
      const bigSpans = Array.from({ length: 10 }, (_, i) =>
        createSpan({
          spanId: `span-${i}`,
          name: `operation-${i}`,
          startTime: [1700000000 + i, 0],
          endTime: [1700000000 + i, 100_000_000],
          attributes: { "big.content": "match_" + "x".repeat(3000) },
        })
      );
      const result = grepTrace(bigSpans, "match_");
      // 4096 tokens * 4 chars = 16384 max
      expect(result.length).toBeLessThanOrEqual(17000);
    });
  });

  describe("when matching span events", () => {
    it("finds matches in event names and attributes", () => {
      const result = grepTrace(spans, "token.generated");
      expect(result).toContain("llm.completion");
      expect(result).toContain("token.generated");
    });
  });
});
