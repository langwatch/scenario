import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { attributes } from "langwatch/observability";

import { deepTransform } from "./deep-transform";
import { truncateMediaUrl, truncateMediaPart } from "./truncate-media";

/**
 * Represents a span node in the hierarchy tree.
 * The `shortId` field is the first 8 hex characters of the span ID,
 * used as a stable reference that LLMs can use directly from the skeleton.
 */
export interface SpanNode {
  span: ReadableSpan;
  children: SpanNode[];
  shortId: string;
}

/**
 * Converts OpenTelemetry high-resolution time to milliseconds.
 */
export function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 * Uses milliseconds for durations under 1 second, seconds with 2 decimal places otherwise.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Calculates the duration of a span in milliseconds.
 */
export function calculateSpanDuration(span: ReadableSpan): number {
  return hrTimeToMs(span.endTime) - hrTimeToMs(span.startTime);
}

/**
 * Returns an error status indicator string for a span.
 * Returns empty string for non-error spans.
 */
export function getStatusIndicator(span: ReadableSpan): string {
  if (span.status.code === 2) {
    return ` ⚠️ ERROR: ${span.status.message ?? "unknown"}`;
  }
  return "";
}

/**
 * Returns a token usage string for LLM spans using the GenAI OTel semantic convention
 * attributes (gen_ai.usage.input_tokens + gen_ai.usage.output_tokens).
 * Returns empty string if no usage attributes are present.
 */
export function getTokenUsage(span: ReadableSpan): string {
  const input = span.attributes["gen_ai.usage.input_tokens"];
  const output = span.attributes["gen_ai.usage.output_tokens"];
  if (input == null && output == null) return "";
  const total = (Number(input) || 0) + (Number(output) || 0);
  return `, ${total} tokens`;
}

/**
 * Removes internal/infrastructure attributes from a span's attribute map.
 * Strips the `langwatch.` prefix from remaining keys and deduplicates.
 */
export function cleanAttributes(
  attrs: Record<string, unknown>
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  const seen = new Set<string>();

  const excludedKeys = [
    attributes.ATTR_LANGWATCH_THREAD_ID,
    "langwatch.scenario.id",
    "langwatch.scenario.name",
  ];

  for (const [key, value] of Object.entries(attrs)) {
    if (excludedKeys.includes(key)) {
      continue;
    }
    const cleanKey = key.replace(/^(langwatch)\./, "");
    if (!seen.has(cleanKey)) {
      seen.add(cleanKey);
      cleaned[cleanKey] = value;
    }
  }
  return cleaned;
}

/**
 * Formats a value for display. Processes media URLs and JSON strings recursively,
 * returning a string representation suitable for trace output.
 */
export function formatValue(value: unknown): string {
  const processed = transformValue(value);
  return typeof processed === "string"
    ? processed
    : JSON.stringify(processed);
}

/**
 * Recursively transforms a value, truncating media content and parsing JSON strings.
 */
export function transformValue(value: unknown): unknown {
  return deepTransform(value, (v) => {
    const mediaPart = truncateMediaPart(v);
    if (mediaPart) return mediaPart;
    if (typeof v !== "string") return v;
    const truncated = truncateMediaUrl(v);
    if (truncated !== v) return truncated;
    if (looksLikeJson(v)) {
      try {
        const parsed = transformValue(JSON.parse(v));
        return JSON.stringify(parsed);
      } catch {
        /* not valid JSON */
      }
    }
    return v;
  });
}

/**
 * Checks if a string looks like it could be valid JSON (starts/ends with {} or []).
 */
export function looksLikeJson(str: string): boolean {
  const t = str.trim();
  return (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  );
}

/**
 * Sorts spans by start time and assigns truncated span IDs (first 8 hex chars).
 * Returns a flat array of SpanNodes with shortId set.
 */
export function indexSpans(spans: ReadableSpan[]): SpanNode[] {
  const sorted = [...spans].sort((a, b) => {
    return hrTimeToMs(a.startTime) - hrTimeToMs(b.startTime);
  });

  return sorted.map((span) => ({
    span,
    children: [],
    shortId: span.spanContext().spanId.slice(0, 8),
  }));
}

/**
 * Extracts the parent span ID from a ReadableSpan, handling both OTel SDK v2
 * (parentSpanId: string) and v1 (parentSpanContext: SpanContext) interfaces.
 */
export function getParentSpanId(span: ReadableSpan): string | undefined {
  if (span.parentSpanId) return span.parentSpanId;
  const legacy = (span as unknown as Record<string, unknown>)
    .parentSpanContext as { spanId?: string } | undefined;
  return legacy?.spanId;
}

/**
 * Builds a parent-child hierarchy from indexed span nodes.
 * Returns the root nodes of the hierarchy tree.
 */
export function buildHierarchy(nodes: SpanNode[]): SpanNode[] {
  const bySpanId = new Map<string, SpanNode>();
  for (const node of nodes) {
    bySpanId.set(node.span.spanContext().spanId, node);
  }

  const roots: SpanNode[] = [];
  for (const node of nodes) {
    const parentId = getParentSpanId(node.span);
    const parent = parentId ? bySpanId.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
