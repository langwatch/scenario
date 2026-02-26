import { describe, it, expect, beforeEach } from "vitest";
import { JudgeSpanCollector } from "../judge-span-collector";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

function createSpan({
  spanId,
  threadId,
  parentSpanId,
}: {
  spanId: string;
  threadId?: string;
  parentSpanId?: string;
}): ReadableSpan {
  const attributes: Record<string, string> = {};
  if (threadId) {
    attributes["langwatch.thread.id"] = threadId;
  }

  return {
    spanContext: () => ({ spanId, traceId: "trace-1", traceFlags: 1, isRemote: false }),
    parentSpanId: parentSpanId,
    parentSpanContext: parentSpanId
      ? { spanId: parentSpanId, traceId: "trace-1", traceFlags: 1, isRemote: false }
      : undefined,
    attributes,
    name: `span-${spanId}`,
    kind: 0,
    startTime: [0, 0],
    endTime: [1, 0],
    status: { code: 0 },
    events: [],
    links: [],
    resource: { attributes: {} },
    instrumentationScope: { name: "test" },
    duration: [1, 0],
    ended: true,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

describe("JudgeSpanCollector", () => {
  let collector: JudgeSpanCollector;

  beforeEach(() => {
    collector = new JudgeSpanCollector();
  });

  describe("clearSpansForThread", () => {
    describe("when the collector has spans for multiple threads", () => {
      beforeEach(() => {
        collector.onEnd(createSpan({ spanId: "s1", threadId: "thread-a" }));
        collector.onEnd(createSpan({ spanId: "s2", threadId: "thread-a" }));
        collector.onEnd(createSpan({ spanId: "s3", threadId: "thread-b" }));
        collector.onEnd(createSpan({ spanId: "s4", threadId: "thread-b" }));
      });

      it("removes spans for the specified thread", () => {
        collector.clearSpansForThread("thread-a");

        const remaining = collector.getSpansForThread("thread-a");
        expect(remaining).toHaveLength(0);
      });

      it("preserves spans for other threads", () => {
        collector.clearSpansForThread("thread-a");

        const remaining = collector.getSpansForThread("thread-b");
        expect(remaining).toHaveLength(2);
      });
    });

    describe("when clearing a thread that does not exist", () => {
      it("does not affect existing spans", () => {
        collector.onEnd(createSpan({ spanId: "s1", threadId: "thread-a" }));

        collector.clearSpansForThread("nonexistent");

        expect(collector.getSpansForThread("thread-a")).toHaveLength(1);
      });
    });

    describe("when span tree contains a cycle", () => {
      it("does not recurse infinitely", () => {
        collector.onEnd(createSpan({ spanId: "a", parentSpanId: "b" }));
        collector.onEnd(createSpan({ spanId: "b", parentSpanId: "a" }));

        expect(() => collector.getSpansForThread("thread-x")).not.toThrow();
        expect(collector.getSpansForThread("thread-x")).toHaveLength(0);
      });
    });

    describe("when child spans inherit thread from parent", () => {
      it("clears both parent and child spans", () => {
        collector.onEnd(createSpan({ spanId: "parent", threadId: "thread-x" }));
        collector.onEnd(createSpan({ spanId: "child", parentSpanId: "parent" }));

        collector.clearSpansForThread("thread-x");

        expect(collector.getSpansForThread("thread-x")).toHaveLength(0);
      });
    });
  });
});
