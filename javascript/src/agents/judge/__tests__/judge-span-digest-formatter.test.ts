import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, it, expect } from "vitest";
import { JudgeSpanDigestFormatter } from "../judge-span-digest-formatter";

/**
 * Creates a mock ReadableSpan for testing.
 */
function createSpan(params: {
  spanId: string;
  name: string;
  startTime: [number, number];
  endTime: [number, number];
  parentSpanId?: string;
  attributes?: Record<string, unknown>;
  events?: Array<{ name: string; attributes?: Record<string, unknown> }>;
  status?: { code: number; message?: string };
}): ReadableSpan {
  return {
    name: params.name,
    spanContext: () => ({ spanId: params.spanId, traceId: "trace-1" }),
    parentSpanContext: params.parentSpanId
      ? { spanId: params.parentSpanId }
      : undefined,
    startTime: params.startTime,
    endTime: params.endTime,
    attributes: params.attributes ?? {},
    events: params.events ?? [],
    status: params.status ?? { code: 0 },
  } as unknown as ReadableSpan;
}

const formatter = new JudgeSpanDigestFormatter();

describe("JudgeSpanDigestFormatter", () => {
  describe("when no spans", () => {
    it("returns empty digest marker", () => {
      expect(formatter.format([])).toMatchInlineSnapshot(`
        "=== OPENTELEMETRY TRACES ===
        No spans recorded."
      `);
    });
  });

  describe("when single span", () => {
    it("includes span name, timestamps, duration, attributes", () => {
      const span = createSpan({
        spanId: "span-1",
        name: "llm.chat",
        startTime: [1700000000, 0],
        endTime: [1700000000, 500_000_000],
        attributes: {
          "gen_ai.prompt": "Hello",
          "gen_ai.completion": "Hi there!",
          model: "gpt-4",
        },
      });

      expect(formatter.format([span])).toMatchInlineSnapshot(`
        "=== OPENTELEMETRY TRACES ===
        Spans: 1 | Total Duration: 500ms

        [1] 2023-11-14T22:13:20.000Z llm.chat (500ms)
            gen_ai.prompt: Hello
            gen_ai.completion: Hi there!
            model: gpt-4
        "
      `);
    });
  });

  describe("when multiple spans", () => {
    it("orders by startTime and assigns sequence numbers", () => {
      const spans = [
        createSpan({
          spanId: "span-2",
          name: "second",
          startTime: [1700000001, 0],
          endTime: [1700000001, 100_000_000],
        }),
        createSpan({
          spanId: "span-1",
          name: "first",
          startTime: [1700000000, 0],
          endTime: [1700000000, 200_000_000],
        }),
        createSpan({
          spanId: "span-3",
          name: "third",
          startTime: [1700000002, 0],
          endTime: [1700000002, 50_000_000],
        }),
      ];

      expect(formatter.format(spans)).toMatchInlineSnapshot(`
        "=== OPENTELEMETRY TRACES ===
        Spans: 3 | Total Duration: 2.05s

        [1] 2023-11-14T22:13:20.000Z first (200ms)

        [2] 2023-11-14T22:13:21.000Z second (100ms)

        [3] 2023-11-14T22:13:22.000Z third (50ms)
        "
      `);
    });
  });

  describe("when spans have parent-child relationship", () => {
    it("nests children under parent with indentation", () => {
      const spans = [
        createSpan({
          spanId: "parent",
          name: "agent.run",
          startTime: [1700000000, 0],
          endTime: [1700000001, 0],
        }),
        createSpan({
          spanId: "child-1",
          name: "llm.call",
          parentSpanId: "parent",
          startTime: [1700000000, 100_000_000],
          endTime: [1700000000, 500_000_000],
        }),
        createSpan({
          spanId: "child-2",
          name: "tool.execute",
          parentSpanId: "parent",
          startTime: [1700000000, 600_000_000],
          endTime: [1700000000, 900_000_000],
        }),
      ];

      expect(formatter.format(spans)).toMatchInlineSnapshot(`
        "=== OPENTELEMETRY TRACES ===
        Spans: 3 | Total Duration: 1.00s

        [1] 2023-11-14T22:13:20.000Z agent.run (1.00s)

        ├── [2] 2023-11-14T22:13:20.100Z llm.call (400ms)

        └── [3] 2023-11-14T22:13:20.600Z tool.execute (300ms)
        "
      `);
    });

    it("handles deep nesting", () => {
      const spans = [
        createSpan({
          spanId: "root",
          name: "root",
          startTime: [1700000000, 0],
          endTime: [1700000002, 0],
        }),
        createSpan({
          spanId: "level-1",
          name: "level-1",
          parentSpanId: "root",
          startTime: [1700000000, 100_000_000],
          endTime: [1700000001, 900_000_000],
        }),
        createSpan({
          spanId: "level-2",
          name: "level-2",
          parentSpanId: "level-1",
          startTime: [1700000000, 200_000_000],
          endTime: [1700000001, 800_000_000],
        }),
      ];

      expect(formatter.format(spans)).toMatchInlineSnapshot(`
        "=== OPENTELEMETRY TRACES ===
        Spans: 3 | Total Duration: 2.00s

        [1] 2023-11-14T22:13:20.000Z root (2.00s)

        └── [2] 2023-11-14T22:13:20.100Z level-1 (1.80s)

        │   └── [3] 2023-11-14T22:13:20.200Z level-2 (1.60s)
        "
      `);
    });
  });

  describe("when span has content attributes", () => {
    it("includes full prompt, completion, and tool content", () => {
      const span = createSpan({
        spanId: "span-1",
        name: "llm.chat",
        startTime: [1700000000, 0],
        endTime: [1700000000, 100_000_000],
        attributes: {
          "gen_ai.prompt": "What is the weather in Paris?",
          "gen_ai.completion": "Let me check the weather for you.",
          "tool.name": "get_weather",
          "tool.input": '{"city": "Paris"}',
          "tool.output": '{"temp": 22, "condition": "sunny"}',
        },
      });

      expect(formatter.format([span])).toMatchInlineSnapshot(`
        "=== OPENTELEMETRY TRACES ===
        Spans: 1 | Total Duration: 100ms

        [1] 2023-11-14T22:13:20.000Z llm.chat (100ms)
            gen_ai.prompt: What is the weather in Paris?
            gen_ai.completion: Let me check the weather for you.
            tool.name: get_weather
            tool.input: {"city":"Paris"}
            tool.output: {"temp":22,"condition":"sunny"}
        "
      `);
    });
  });

  describe("when span has error status", () => {
    it("marks span with error indicator and collects in summary", () => {
      const spans = [
        createSpan({
          spanId: "span-1",
          name: "successful.operation",
          startTime: [1700000000, 0],
          endTime: [1700000000, 100_000_000],
        }),
        createSpan({
          spanId: "span-2",
          name: "failed.operation",
          startTime: [1700000000, 200_000_000],
          endTime: [1700000000, 300_000_000],
          status: { code: 2, message: "Connection refused" },
        }),
      ];

      expect(formatter.format(spans)).toMatchInlineSnapshot(`
        "=== OPENTELEMETRY TRACES ===
        Spans: 2 | Total Duration: 300ms

        [1] 2023-11-14T22:13:20.000Z successful.operation (100ms)

        [2] 2023-11-14T22:13:20.200Z failed.operation (100ms) ⚠️ ERROR: Connection refused


        === ERRORS ===
        - failed.operation: Connection refused"
      `);
    });
  });

  describe("when span has events", () => {
    it("renders events with attributes", () => {
      const span = createSpan({
        spanId: "span-1",
        name: "llm.stream",
        startTime: [1700000000, 0],
        endTime: [1700000001, 0],
        events: [
          {
            name: "token.generated",
            attributes: { token: "Hello", index: 0 },
          },
          {
            name: "token.generated",
            attributes: { token: " world", index: 1 },
          },
        ],
      });

      expect(formatter.format([span])).toMatchInlineSnapshot(`
        "=== OPENTELEMETRY TRACES ===
        Spans: 1 | Total Duration: 1.00s

        [1] 2023-11-14T22:13:20.000Z llm.stream (1.00s)
            [event] token.generated
              token: Hello
              index: 0
            [event] token.generated
              token:  world
              index: 1
        "
      `);
    });
  });

  describe("when attributes include filtered keys", () => {
    it("excludes thread.id, scenario.id, scenario.name", () => {
      const span = createSpan({
        spanId: "span-1",
        name: "test",
        startTime: [1700000000, 0],
        endTime: [1700000000, 100_000_000],
        attributes: {
          "langwatch.thread.id": "thread-123",
          "langwatch.scenario.id": "scenario-456",
          "langwatch.scenario.name": "my-scenario",
          "relevant.attribute": "should-appear",
        },
      });

      expect(formatter.format([span])).toMatchInlineSnapshot(`
        "=== OPENTELEMETRY TRACES ===
        Spans: 1 | Total Duration: 100ms

        [1] 2023-11-14T22:13:20.000Z test (100ms)
            relevant.attribute: should-appear
        "
      `);
    });
  });

  describe("when deduplicating content", () => {
    it("replaces duplicate strings with marker", () => {
      const longContent =
        "This is a long string that exceeds the threshold for deduplication testing purposes.";
      const spans = [
        createSpan({
          spanId: "span-1",
          name: "first",
          startTime: [1700000000, 0],
          endTime: [1700000000, 100_000_000],
          attributes: { content: longContent },
        }),
        createSpan({
          spanId: "span-2",
          name: "second",
          startTime: [1700000000, 200_000_000],
          endTime: [1700000000, 300_000_000],
          attributes: { content: longContent },
        }),
      ];

      const result = formatter.format(spans);
      expect(result).toContain(longContent);
      expect(result).toContain("[DUPLICATE - SEE ABOVE]");
      expect(result.indexOf(longContent)).toBeLessThan(
        result.indexOf("[DUPLICATE - SEE ABOVE]"),
      );
    });

    it("deduplicates content inside JSON strings", () => {
      const longMessage =
        "This is a long message that should be deduplicated when it appears multiple times.";
      const spans = [
        createSpan({
          spanId: "span-1",
          name: "first",
          startTime: [1700000000, 0],
          endTime: [1700000000, 100_000_000],
          attributes: {
            input: JSON.stringify({
              messages: [{ role: "user", content: longMessage }],
            }),
          },
        }),
        createSpan({
          spanId: "span-2",
          name: "second",
          startTime: [1700000000, 200_000_000],
          endTime: [1700000000, 300_000_000],
          attributes: {
            input: JSON.stringify({
              messages: [{ role: "user", content: longMessage }],
            }),
          },
        }),
      ];

      const result = formatter.format(spans);
      const occurrences = result.split(longMessage).length - 1;
      expect(occurrences).toBe(1);
      expect(result).toContain("[DUPLICATE - SEE ABOVE]");
    });

    it("normalizes whitespace when comparing for duplicates", () => {
      const content1 =
        "This is a long line one with plenty of content\nLine two has more text\nLine three completes it";
      const content2 =
        "This is a long line one with plenty of content\n\nLine two has more text\n  Line three completes it";
      const spans = [
        createSpan({
          spanId: "span-1",
          name: "first",
          startTime: [1700000000, 0],
          endTime: [1700000000, 100_000_000],
          attributes: { content: content1 },
        }),
        createSpan({
          spanId: "span-2",
          name: "second",
          startTime: [1700000000, 200_000_000],
          endTime: [1700000000, 300_000_000],
          attributes: { content: content2 },
        }),
      ];

      const result = formatter.format(spans);
      expect(result).toContain("[DUPLICATE - SEE ABOVE]");
    });

    it("does not deduplicate short strings below threshold", () => {
      const shortContent = "Short";
      const spans = [
        createSpan({
          spanId: "span-1",
          name: "first",
          startTime: [1700000000, 0],
          endTime: [1700000000, 100_000_000],
          attributes: { content: shortContent },
        }),
        createSpan({
          spanId: "span-2",
          name: "second",
          startTime: [1700000000, 200_000_000],
          endTime: [1700000000, 300_000_000],
          attributes: { content: shortContent },
        }),
      ];

      const result = formatter.format(spans);
      const occurrences = result.split(shortContent).length - 1;
      expect(occurrences).toBe(2);
      expect(result).not.toContain("[DUPLICATE - SEE ABOVE]");
    });

    it("resets deduplication state between format calls", () => {
      const longContent =
        "This content appears in both calls but should show fully each time.";
      const span = createSpan({
        spanId: "span-1",
        name: "test",
        startTime: [1700000000, 0],
        endTime: [1700000000, 100_000_000],
        attributes: { content: longContent },
      });

      const result1 = formatter.format([span]);
      const result2 = formatter.format([span]);

      expect(result1).toContain(longContent);
      expect(result2).toContain(longContent);
      expect(result1).not.toContain("[DUPLICATE - SEE ABOVE]");
      expect(result2).not.toContain("[DUPLICATE - SEE ABOVE]");
    });
  });
});
