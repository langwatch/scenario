import { SpanStatusCode } from "@opentelemetry/api";
import { describe, it, expect } from "vitest";
import { createSpan } from "../../agents/judge/__tests__/helpers/create-span";
import { JudgeSpanCollector } from "../../agents/judge/judge-span-collector";
import {
  langwatchApiSpanToReadableSpan,
  type LangWatchApiSpan,
} from "../langwatch-api-span";
import {
  collectMessageTraceIds,
  RemoteTraceFetcher,
} from "../remote-trace-fetcher";

const THREAD_ID = "thread-1";
const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const LANGWATCH = { endpoint: "https://langwatch.test", apiKey: "key-123" };

function apiSpan(
  overrides: Partial<LangWatchApiSpan> = {}
): LangWatchApiSpan {
  return {
    span_id: "b000000000000001",
    trace_id: TRACE_ID,
    type: "tool",
    name: "get_weather",
    timestamps: { started_at: 1_700_000_000_000, finished_at: 1_700_000_000_500 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Fake trace API: each call shifts the next scripted result. A result can be
 * an array of spans ("responses" queue), the string "404", or an Error to
 * throw. When the queue empties, the last result repeats.
 */
function fakeTraceApi(script: Array<LangWatchApiSpan[] | "404" | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const queue = [...script];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const result = queue.length > 1 ? queue.shift() : queue[0];
    if (result instanceof Error) throw result;
    if (result === "404") return jsonResponse({ error: "not found" }, 404);
    return jsonResponse({ trace_id: TRACE_ID, spans: result });
  };
  return { calls, fetchFn };
}

function makeFetcher(fetchFn: typeof fetch): RemoteTraceFetcher {
  return new RemoteTraceFetcher({ fetchFn, pollIntervalMs: 1 });
}

function target(collector: JudgeSpanCollector, traceIds: string[] = [TRACE_ID]) {
  return { threadId: THREAD_ID, traceIds, collector, langwatch: LANGWATCH };
}

describe("RemoteTraceFetcher", () => {
  describe("when a non-blocking fetch round finds spans", () => {
    it("feeds converted spans into the collector tagged with the thread id", async () => {
      const collector = new JudgeSpanCollector();
      const { calls, fetchFn } = fakeTraceApi([[apiSpan()]]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.fetchOnce(target(collector));

      expect(calls).toHaveLength(1);
      const spans = collector.getSpansForThread(THREAD_ID);
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("get_weather");
      expect(spans[0].attributes["langwatch.span.type"]).toBe("tool");
      expect(spans[0].attributes["langwatch.thread.id"]).toBe(THREAD_ID);
    });

    it("sends the API key as both X-Auth-Token and Authorization Bearer", async () => {
      const collector = new JudgeSpanCollector();
      const { calls, fetchFn } = fakeTraceApi([[apiSpan()]]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.fetchOnce(target(collector));

      expect(calls[0].url).toBe(
        `https://langwatch.test/api/trace/${TRACE_ID}`
      );
      expect(calls[0].headers["X-Auth-Token"]).toBe("key-123");
      expect(calls[0].headers["Authorization"]).toBe("Bearer key-123");
    });
  });

  describe("when the trace has not arrived yet (404)", () => {
    it("treats it as zero spans, not an error", async () => {
      const collector = new JudgeSpanCollector();
      const { calls, fetchFn } = fakeTraceApi(["404"]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.fetchOnce(target(collector));

      expect(calls).toHaveLength(1);
      expect(collector.getSpansForThread(THREAD_ID)).toHaveLength(0);
    });
  });

  describe("when a non-blocking fetch fails", () => {
    it("swallows the failure without a synthetic error span", async () => {
      const collector = new JudgeSpanCollector();
      const { fetchFn } = fakeTraceApi([new Error("connection refused")]);
      const fetcher = makeFetcher(fetchFn);

      await expect(fetcher.fetchOnce(target(collector))).resolves.toBeUndefined();
      expect(collector.getSpansForThread(THREAD_ID)).toHaveLength(0);
      expect(fetcher.hasUnsettled(THREAD_ID, [TRACE_ID])).toBe(true);
    });
  });

  describe("when the settle-wait polls a trace that arrives late", () => {
    it("polls until the fetched spans form a parent-resolved trace with a remote span", async () => {
      const collector = new JudgeSpanCollector();
      const { calls, fetchFn } = fakeTraceApi([
        "404",
        "404",
        [apiSpan()],
      ]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.settleWait({ ...target(collector), timeoutMs: 5_000 });

      expect(calls).toHaveLength(3);
      expect(fetcher.hasUnsettled(THREAD_ID, [TRACE_ID])).toBe(false);
      expect(collector.getSpansForThread(THREAD_ID)).toHaveLength(1);
    });

    it("settles a complete trace during the non-blocking round so the verdict adds no polls", async () => {
      const collector = new JudgeSpanCollector();
      const { calls, fetchFn } = fakeTraceApi([[apiSpan()]]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.fetchOnce(target(collector));
      expect(calls).toHaveLength(1);
      expect(fetcher.hasUnsettled(THREAD_ID, [TRACE_ID])).toBe(false);

      await fetcher.settleWait({ ...target(collector), timeoutMs: 5_000 });

      expect(calls).toHaveLength(1);
    });

    it("does not settle on a repeated partial chunk while parents are unresolved", async () => {
      const collector = new JudgeSpanCollector();
      const orphanChunk = [
        apiSpan({
          span_id: "b000000000000002",
          name: "tools.round_one",
          parent_id: "b000000000000001",
        }),
      ];
      const fullTrace = [
        apiSpan({ span_id: "b000000000000001", name: "agent.request" }),
        ...orphanChunk,
        apiSpan({
          span_id: "b000000000000003",
          name: "db.write",
          parent_id: "b000000000000001",
        }),
      ];
      // The partial chunk repeats for three polls: a count-stability rule
      // would have settled on it and missed db.write entirely.
      const { calls, fetchFn } = fakeTraceApi([
        orphanChunk,
        orphanChunk,
        orphanChunk,
        fullTrace,
      ]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.settleWait({ ...target(collector), timeoutMs: 5_000 });

      expect(calls).toHaveLength(4);
      expect(fetcher.hasUnsettled(THREAD_ID, [TRACE_ID])).toBe(false);
      const names = collector.getSpansForThread(THREAD_ID).map((s) => s.name);
      expect(names).toContain("db.write");
      expect(names).toContain("agent.request");
    });

    it("keeps the collected spans and adds an incomplete-trace error span when parents never resolve by the deadline", async () => {
      const collector = new JudgeSpanCollector();
      const { calls, fetchFn } = fakeTraceApi([
        [apiSpan({ parent_id: "b0000000000000ff" })],
      ]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.settleWait({ ...target(collector), timeoutMs: 40 });

      expect(calls.length).toBeGreaterThan(2);
      expect(fetcher.hasUnsettled(THREAD_ID, [TRACE_ID])).toBe(false);
      const spans = collector.getSpansForThread(THREAD_ID);
      const names = spans.map((s) => s.name);
      expect(names).toContain("get_weather");
      expect(names).toContain("langwatch.span_collection.error");
      const errorSpan = spans.find(
        (s) => s.name === "langwatch.span_collection.error"
      );
      expect(
        errorSpan?.attributes["langwatch.span_collection.error.reason"]
      ).toContain("still incomplete");
    });

    it("never settles a trace that only contains the scenario's own local spans", async () => {
      const collector = new JudgeSpanCollector();
      const localSpan = createSpan({
        spanId: "b000000000000001",
        name: "local.op",
        startTime: [1_700_000_000, 0],
        endTime: [1_700_000_001, 0],
        attributes: { "langwatch.thread.id": THREAD_ID },
      });
      collector.onEnd(localSpan);
      const { calls, fetchFn } = fakeTraceApi([
        [apiSpan({ span_id: "b000000000000001", name: "local.op" })],
      ]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.settleWait({ ...target(collector), timeoutMs: 60 });

      expect(calls.length).toBeGreaterThan(3);
      const spans = collector.getSpansForThread(THREAD_ID);
      const names = spans.map((s) => s.name);
      expect(names).toContain("langwatch.span_collection.error");
      const errorSpan = spans.find(
        (s) => s.name === "langwatch.span_collection.error"
      );
      expect(
        errorSpan?.attributes["langwatch.span_collection.error.reason"]
      ).toContain("no agent spans arrived");
      expect(fetcher.hasUnsettled(THREAD_ID, [TRACE_ID])).toBe(false);
    });

    it("skips already settled ids on later rounds", async () => {
      const collector = new JudgeSpanCollector();
      const { calls, fetchFn } = fakeTraceApi([[apiSpan()]]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.settleWait({ ...target(collector), timeoutMs: 5_000 });
      const settledCallCount = calls.length;

      await fetcher.fetchOnce(target(collector));
      await fetcher.settleWait({ ...target(collector), timeoutMs: 5_000 });

      expect(calls).toHaveLength(settledCallCount);
    });

    it("settles multiple trace ids in parallel", async () => {
      const otherTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2";
      const collector = new JudgeSpanCollector();
      const perTrace = new Map<string, number>();
      const fetchFn: typeof fetch = async (input) => {
        const url = String(input);
        const traceId = url.slice(url.lastIndexOf("/") + 1);
        const count = (perTrace.get(traceId) ?? 0) + 1;
        perTrace.set(traceId, count);
        return jsonResponse({
          spans: [apiSpan({ trace_id: traceId, span_id: `c${traceId.slice(-3)}` })],
        });
      };
      const fetcher = makeFetcher(fetchFn);

      await fetcher.settleWait({
        ...target(collector, [TRACE_ID, otherTraceId]),
        timeoutMs: 5_000,
      });

      expect(perTrace.get(TRACE_ID)).toBe(1);
      expect(perTrace.get(otherTraceId)).toBe(1);
      expect(fetcher.hasUnsettled(THREAD_ID, [TRACE_ID, otherTraceId])).toBe(
        false
      );
    });
  });

  describe("when the settle-wait times out", () => {
    it("feeds exactly one synthetic error span carrying the reason", async () => {
      const collector = new JudgeSpanCollector();
      const { fetchFn } = fakeTraceApi(["404"]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.settleWait({ ...target(collector), timeoutMs: 20 });
      await fetcher.settleWait({ ...target(collector), timeoutMs: 20 });

      const spans = collector.getSpansForThread(THREAD_ID);
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("langwatch.span_collection.error");
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0].status.message).toContain("Timed out after 20ms");
      expect(spans[0].attributes["langwatch.span_collection.error"]).toBe(true);
      expect(
        spans[0].attributes["langwatch.span_collection.error.reason"]
      ).toContain("Timed out after 20ms");
      expect(spans[0].attributes["langwatch.thread.id"]).toBe(THREAD_ID);
      expect(fetcher.hasUnsettled(THREAD_ID, [TRACE_ID])).toBe(false);
    });
  });

  describe("when the settle-wait hits a hard fetch failure", () => {
    it("feeds a synthetic error span with the failure reason and never throws", async () => {
      const collector = new JudgeSpanCollector();
      const { fetchFn } = fakeTraceApi([new Error("boom from the API")]);
      const fetcher = makeFetcher(fetchFn);

      await expect(
        fetcher.settleWait({ ...target(collector), timeoutMs: 5_000 })
      ).resolves.toBeUndefined();

      const spans = collector.getSpansForThread(THREAD_ID);
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("langwatch.span_collection.error");
      expect(spans[0].status.message).toBe("boom from the API");
    });
  });

  describe("when remote spans overlap locally collected spans", () => {
    it("dedupes by span id and filters scenario infrastructure spans", async () => {
      const collector = new JudgeSpanCollector();
      const localSpan = createSpan({
        spanId: "b000000000000001",
        name: "local.copy",
        startTime: [1_700_000_000, 0],
        endTime: [1_700_000_001, 0],
        attributes: { "langwatch.thread.id": THREAD_ID },
      });
      collector.onEnd(localSpan);

      const { fetchFn } = fakeTraceApi([
        [
          apiSpan({ span_id: "b000000000000001", name: "remote.copy" }),
          apiSpan({ span_id: "b000000000000002", name: "db.write" }),
          apiSpan({ span_id: "b000000000000003", name: "langwatch.scenario.run" }),
          apiSpan({ span_id: "b000000000000004", name: "langwatch.judge.call" }),
          apiSpan({
            span_id: "b000000000000005",
            name: "langwatch.user_simulator.call",
          }),
        ],
      ]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.fetchOnce(target(collector));

      const spans = collector.getSpansForThread(THREAD_ID);
      const names = spans.map((s) => s.name).sort();
      expect(names).toEqual(["db.write", "local.copy"]);
    });
  });

  describe("when a thread's state is cleared", () => {
    it("forgets settled ids so a new run fetches again", async () => {
      const collector = new JudgeSpanCollector();
      const { calls, fetchFn } = fakeTraceApi([[apiSpan()]]);
      const fetcher = makeFetcher(fetchFn);

      await fetcher.settleWait({ ...target(collector), timeoutMs: 5_000 });
      expect(fetcher.hasUnsettled(THREAD_ID, [TRACE_ID])).toBe(false);

      fetcher.clearForThread(THREAD_ID);

      expect(fetcher.hasUnsettled(THREAD_ID, [TRACE_ID])).toBe(true);
      await fetcher.fetchOnce(target(new JudgeSpanCollector()));
      expect(calls.length).toBeGreaterThan(1);
    });
  });
});

describe("collectMessageTraceIds", () => {
  it("returns all distinct trace ids in first-seen order", () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b", traceId: "t-1" },
      { role: "user", content: "c", traceId: "t-2" },
      { role: "assistant", content: "d", traceId: "t-1" },
      { role: "assistant", content: "e", traceId: "t-3" },
    ];
    expect(collectMessageTraceIds(messages as never)).toEqual([
      "t-1",
      "t-2",
      "t-3",
    ]);
  });

  it("skips the invalid all-zero trace id from a non-recording tracer", () => {
    const messages = [
      {
        role: "assistant",
        content: "a",
        traceId: "00000000000000000000000000000000",
      },
    ];
    expect(collectMessageTraceIds(messages as never)).toEqual([]);
  });
});

describe("langwatchApiSpanToReadableSpan", () => {
  it("converts epoch millisecond timestamps to HrTime", () => {
    const span = langwatchApiSpanToReadableSpan(
      apiSpan({
        timestamps: { started_at: 1_700_000_000_123, finished_at: 1_700_000_001_500 },
      })
    );
    expect(span.startTime).toEqual([1_700_000_000, 123_000_000]);
    expect(span.endTime).toEqual([1_700_000_001, 500_000_000]);
    expect(span.duration).toEqual([1, 377_000_000]);
  });

  it("exposes the span context and the parent span context", () => {
    const span = langwatchApiSpanToReadableSpan(
      apiSpan({ parent_id: "b0000000000000ff" })
    );
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.spanContext().spanId).toBe("b000000000000001");
    expect(span.parentSpanContext?.spanId).toBe("b0000000000000ff");
  });

  it("maps input and output payloads into attributes the judge can read", () => {
    const span = langwatchApiSpanToReadableSpan(
      apiSpan({
        input: { type: "json", value: { table: "orders", id: 7 } },
        output: { type: "text", value: "written" },
      })
    );
    expect(span.attributes["input"]).toBe('{"table":"orders","id":7}');
    expect(span.attributes["output"]).toBe("written");
  });

  it("maps chat message payloads into gen_ai attributes", () => {
    const span = langwatchApiSpanToReadableSpan(
      apiSpan({
        type: "llm",
        model: "openai/gpt-5-mini",
        input: { type: "chat_messages", value: [{ role: "user", content: "hi" }] },
      })
    );
    expect(span.attributes["langwatch.span.type"]).toBe("llm");
    expect(span.attributes["gen_ai.request.model"]).toBe("openai/gpt-5-mini");
    expect(span.attributes["gen_ai.input.messages"]).toBe(
      '[{"role":"user","content":"hi"}]'
    );
  });

  it("maps a span error into an ERROR status with the message", () => {
    const span = langwatchApiSpanToReadableSpan(
      apiSpan({
        error: { has_error: true, message: "tool exploded", stacktrace: [] },
      })
    );
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("tool exploded");
  });
});
