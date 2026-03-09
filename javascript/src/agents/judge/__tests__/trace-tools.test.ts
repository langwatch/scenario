import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, it, expect } from "vitest";
import { expandTrace, grepTrace } from "../trace-tools";
import { createSpan } from "./helpers/create-span";

function buildSpanSet(): ReadableSpan[] {
  return [
    createSpan({
      spanId: "a0b1c2d3e4f56789",
      name: "agent.run",
      startTime: [1700000000, 0],
      endTime: [1700000002, 0],
      attributes: { "agent.type": "rag" },
    }),
    createSpan({
      spanId: "b1c2d3e4f5678901",
      name: "llm.call",
      parentSpanId: "a0b1c2d3e4f56789",
      startTime: [1700000000, 100_000_000],
      endTime: [1700000000, 500_000_000],
      attributes: {
        "gen_ai.prompt": "What is the weather in Paris?",
        "gen_ai.completion": "Let me check the weather for you.",
        model: "gpt-4",
      },
    }),
    createSpan({
      spanId: "c2d3e4f567890123",
      name: "tool.fetch_report",
      parentSpanId: "a0b1c2d3e4f56789",
      startTime: [1700000000, 600_000_000],
      endTime: [1700000000, 900_000_000],
      attributes: {
        "tool.name": "fetch_report",
        "tool.input": '{"city": "Paris"}',
        "tool.output": '{"temp": 22, "condition": "sunny"}',
      },
    }),
    createSpan({
      spanId: "d3e4f56789012345",
      name: "llm.completion",
      parentSpanId: "a0b1c2d3e4f56789",
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
      spanId: "e4f5678901234567",
      name: "failed.operation",
      parentSpanId: "a0b1c2d3e4f56789",
      startTime: [1700000001, 600_000_000],
      endTime: [1700000001, 700_000_000],
      status: { code: 2, message: "Connection refused" },
      attributes: { "error.type": "NetworkError" },
    }),
  ];
}

describe("expandTrace", () => {
  const spans = buildSpanSet();

  describe("when given a valid span ID", () => {
    it("returns full span details with all attributes and events", () => {
      const result = expandTrace(spans, ["b1c2d3e4"]);
      expect(result).toContain("llm.call");
      expect(result).toContain("gen_ai.prompt");
      expect(result).toContain("What is the weather in Paris?");
      expect(result).toContain("gen_ai.completion");
      expect(result).toContain("gpt-4");
    });

    it("shows the span ID in brackets", () => {
      const result = expandTrace(spans, ["b1c2d3e4"]);
      expect(result).toContain("[b1c2d3e4]");
      expect(result).toContain("llm.call");
    });
  });

  describe("when given multiple span IDs", () => {
    it("returns full details for all matching spans", () => {
      const result = expandTrace(spans, ["b1c2d3e4", "c2d3e4f5"]);
      expect(result).toContain("llm.call");
      expect(result).toContain("tool.fetch_report");
      expect(result).toContain("gen_ai.prompt");
      expect(result).toContain("fetch_report");
    });
  });

  describe("when given a non-matching span ID", () => {
    it("returns error message with available span IDs", () => {
      const result = expandTrace(spans, ["ffffffff"]);
      expect(result).toContain("no spans matched");
      expect(result).toContain("a0b1c2d3");
    });
  });

  describe("when span has events", () => {
    it("includes events in the expanded output", () => {
      const result = expandTrace(spans, ["d3e4f567"]);
      expect(result).toContain("token.generated");
      expect(result).toContain("token: The");
    });
  });

  describe("when span has error status", () => {
    it("includes error indicator", () => {
      const result = expandTrace(spans, ["e4f56789"]);
      expect(result).toContain("ERROR");
      expect(result).toContain("Connection refused");
    });
  });

  describe("when result exceeds token budget", () => {
    it("truncates to approximately 4096 tokens and adds truncation note", () => {
      const bigSpans = [
        createSpan({
          spanId: "aabb00112233aabb",
          name: "big.span",
          startTime: [1700000000, 0],
          endTime: [1700000001, 0],
          attributes: {
            "massive.content": "x".repeat(20000),
          },
        }),
      ];
      const result = expandTrace(bigSpans, ["aabb0011"]);
      // 4096 tokens * 4 chars = 16384 chars max
      expect(result.length).toBeLessThanOrEqual(17000); // some slack for truncation note
      expect(result).toContain("[TRUNCATED]");
    });
  });

  describe("when prefix matches multiple spans", () => {
    it("returns all matching spans", () => {
      const prefixSpans = [
        createSpan({
          spanId: "aa11bb22cc33dd44",
          name: "first.op",
          startTime: [1700000000, 0],
          endTime: [1700000000, 100_000_000],
        }),
        createSpan({
          spanId: "aa11bb22dd44ee55",
          name: "second.op",
          startTime: [1700000000, 200_000_000],
          endTime: [1700000000, 300_000_000],
        }),
      ];
      const result = expandTrace(prefixSpans, ["aa11bb22"]);
      expect(result).toContain("first.op");
      expect(result).toContain("second.op");
    });
  });

  describe("when no parameters provided", () => {
    it("returns error message", () => {
      const result = expandTrace(spans, []);
      expect(result).toContain("Error");
    });
  });

  describe("when spans are empty", () => {
    it("returns no spans message", () => {
      const result = expandTrace([], ["anything"]);
      expect(result).toBe("No spans recorded.");
    });
  });
});

describe("grepTrace", () => {
  const spans = buildSpanSet();

  describe("when pattern matches span attributes", () => {
    it("returns matching spans with span ID headers", () => {
      const result = grepTrace(spans, "fetch_report");
      expect(result).toContain("fetch_report");
      expect(result).toContain("[c2d3e4f5]");
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
          spanId: `${i.toString(16).padStart(16, "0")}`,
          name: `operation-${i}`,
          startTime: [1700000000 + i, 0],
          endTime: [1700000000 + i, 100_000_000],
          attributes: { "common.attr": "matching_value" },
        })
      );
      const result = grepTrace(manySpans, "matching_value");
      // Count the number of span headers (8-char hex IDs in brackets)
      const matchHeaders = result.match(/\[[0-9a-f]{8}\]/g) ?? [];
      expect(matchHeaders.length).toBeLessThanOrEqual(20);
      expect(result).toContain("more match");
    });
  });

  describe("when grep result exceeds token budget", () => {
    it("truncates total output to approximately 4096 tokens", () => {
      const bigSpans = Array.from({ length: 10 }, (_, i) =>
        createSpan({
          spanId: `${i.toString(16).padStart(16, "0")}`,
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
