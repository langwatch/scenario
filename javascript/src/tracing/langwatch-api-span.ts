import type { Attributes, HrTime, SpanContext, SpanStatus } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/**
 * A span as returned by the LangWatch trace API (`GET /api/trace/{traceId}`).
 *
 * Structural subset of the platform's span schema: every field the converter
 * reads is optional except the ids, so a partially populated span still
 * converts. Timestamps are epoch milliseconds.
 */
export interface LangWatchApiSpan {
  span_id: string;
  trace_id: string;
  parent_id?: string | null;
  type?: string | null;
  name?: string | null;
  input?: { type: string; value: unknown } | null;
  output?: { type: string; value: unknown } | null;
  error?: { has_error: true; message: string; stacktrace: string[] } | null;
  timestamps?: {
    started_at: number;
    finished_at: number;
  } | null;
  metrics?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    cost?: number | null;
  } | null;
  params?: Record<string, unknown> | null;
  model?: string | null;
  vendor?: string | null;
  contexts?: unknown[] | null;
}

function msToHrTime(ms: number): HrTime {
  const seconds = Math.trunc(ms / 1000);
  const nanoseconds = (ms % 1000) * 1_000_000;
  return [seconds, nanoseconds];
}

function hrTimeDuration(start: HrTime, end: HrTime): HrTime {
  let seconds = end[0] - start[0];
  let nanoseconds = end[1] - start[1];
  if (nanoseconds < 0) {
    seconds -= 1;
    nanoseconds += 1_000_000_000;
  }
  return [seconds, nanoseconds];
}

function spanTypeToKind(type: string): SpanKind {
  switch (type) {
    case "server":
      return SpanKind.SERVER;
    case "client":
      return SpanKind.CLIENT;
    case "producer":
      return SpanKind.PRODUCER;
    case "consumer":
      return SpanKind.CONSUMER;
    default:
      return SpanKind.INTERNAL;
  }
}

/**
 * Recursively flattens a nested params object into dot-notation OTel
 * attributes.
 *
 * - Primitive values (string, number, boolean) are set directly
 * - Plain objects are recursed into
 * - Arrays are JSON.stringified
 * - null/undefined values are skipped
 * - The `_keys` field is skipped (indexing artifact)
 */
function flattenParams({
  params,
  prefix,
  attrs,
}: {
  params: Record<string, unknown>;
  prefix: string;
  attrs: Attributes;
}): void {
  for (const [key, value] of Object.entries(params)) {
    if (key === "_keys") continue;
    if (value == null) continue;

    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      attrs[fullKey] = value;
    } else if (Array.isArray(value)) {
      attrs[fullKey] = JSON.stringify(value);
    } else if (typeof value === "object") {
      flattenParams({
        params: value as Record<string, unknown>,
        prefix: fullKey,
        attrs,
      });
    }
  }
}

/**
 * Renders a span input/output payload as a readable attribute string.
 *
 * The API shape is `{ type, value }`. Plain text values stay raw strings;
 * anything else (chat messages, JSON) is JSON-encoded. Mirrors the Python
 * SDK's `_io_value_to_attribute` so both write the same string.
 */
function ioValueToAttribute(
  io: { type: string; value: unknown } | null | undefined
): string | null {
  const value = io?.value;
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildAttributes(span: LangWatchApiSpan): Attributes {
  const attrs: Attributes = {};

  attrs["langwatch.span.type"] = span.type ?? "span";

  // Input and output. Both SDKs write the same two keys with the same
  // serialization (a string value stays raw, anything else is JSON), so a
  // judge prompt reads the same digest whichever SDK fetched the trace. Chat
  // messages additionally get the gen_ai semantic-convention key.
  const inputValue = ioValueToAttribute(span.input);
  if (inputValue != null) {
    attrs["langwatch.input"] = inputValue;
    if (span.input?.type === "chat_messages") {
      attrs["gen_ai.input.messages"] = inputValue;
    }
  }

  const outputValue = ioValueToAttribute(span.output);
  if (outputValue != null) {
    attrs["langwatch.output"] = outputValue;
    if (span.output?.type === "chat_messages") {
      attrs["gen_ai.output.messages"] = outputValue;
    }
  }

  // LLM-specific
  if (span.model) {
    attrs["gen_ai.request.model"] = span.model;
  }
  if (span.vendor) {
    attrs["gen_ai.system"] = span.vendor;
  }

  // Params
  if (span.params) {
    if (span.params.temperature != null)
      attrs["gen_ai.request.temperature"] = span.params.temperature as number;
    if (span.params.max_tokens != null)
      attrs["gen_ai.request.max_tokens"] = span.params.max_tokens as number;
    if (span.params.top_p != null)
      attrs["gen_ai.request.top_p"] = span.params.top_p as number;

    flattenParams({ params: span.params, prefix: "", attrs });
  }

  // Metrics
  if (span.metrics) {
    if (span.metrics.prompt_tokens != null)
      attrs["gen_ai.usage.prompt_tokens"] = span.metrics.prompt_tokens;
    if (span.metrics.completion_tokens != null)
      attrs["gen_ai.usage.completion_tokens"] = span.metrics.completion_tokens;
    if (span.metrics.cost != null)
      attrs["gen_ai.usage.cost"] = span.metrics.cost;
  }

  // RAG contexts
  if (span.contexts) {
    attrs["retrieval.documents"] = JSON.stringify(span.contexts);
  }

  return attrs;
}

function buildStatus(span: LangWatchApiSpan): SpanStatus {
  if (span.error) {
    return { code: SpanStatusCode.ERROR, message: span.error.message };
  }
  return { code: SpanStatusCode.OK };
}

/**
 * Converts a LangWatch API span into a `ReadableSpan`-alike object exposing
 * everything the judge span digest formatter and the expand_trace/grep_trace
 * tools consume: name, attributes, events, start/end HrTime, status,
 * spanContext() and the parent span context.
 *
 * Span type, input, output, error, params, and metrics are mapped into OTel
 * attributes (`langwatch.span.type`, `langwatch.input`/`langwatch.output`,
 * `gen_ai.*`) so the judge can read tool names and payloads. API timestamps
 * are epoch milliseconds; ReadableSpan times are HrTime `[seconds, nanos]`.
 */
export function langwatchApiSpanToReadableSpan(
  span: LangWatchApiSpan
): ReadableSpan {
  const startTime = msToHrTime(span.timestamps?.started_at ?? 0);
  const endTime = msToHrTime(span.timestamps?.finished_at ?? 0);
  const duration = hrTimeDuration(startTime, endTime);

  const spanCtx: SpanContext = {
    traceId: span.trace_id,
    spanId: span.span_id,
    traceFlags: TraceFlags.SAMPLED,
  };

  const parentSpanCtx: SpanContext | undefined = span.parent_id
    ? {
        traceId: span.trace_id,
        spanId: span.parent_id,
        traceFlags: TraceFlags.SAMPLED,
      }
    : undefined;

  return {
    name: span.name ?? "",
    kind: spanTypeToKind(span.type ?? "span"),
    spanContext: () => spanCtx,
    parentSpanContext: parentSpanCtx,
    startTime,
    endTime,
    status: buildStatus(span),
    attributes: buildAttributes(span),
    links: [],
    events: [],
    duration,
    ended: true,
    // Digest formatting and trace tools never read the resource; a minimal
    // stub avoids depending on @opentelemetry/resources for emptyResource().
    resource: { attributes: {} },
    instrumentationScope: { name: "langwatch" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}
