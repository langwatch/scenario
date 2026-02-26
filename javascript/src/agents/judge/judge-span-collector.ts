import { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { attributes } from "langwatch/observability";

/**
 * Collects OpenTelemetry spans for judge evaluation.
 * Implements SpanProcessor to intercept spans as they complete.
 */
export class JudgeSpanCollector implements SpanProcessor {
  private spans: ReadableSpan[] = [];

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    this.spans.push(span);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.spans = [];
    return Promise.resolve();
  }

  /**
   * Removes all spans associated with a specific thread.
   * Call this after a scenario run completes to prevent memory growth
   * in long-lived processes.
   * @param threadId - The thread identifier whose spans should be cleared
   */
  clearSpansForThread(threadId: string): void {
    const threadSpanIds = new Set(
      this.getSpansForThread(threadId).map((s) => s.spanContext().spanId)
    );
    this.spans = this.spans.filter(
      (s) => !threadSpanIds.has(s.spanContext().spanId)
    );
  }

  /**
   * Retrieves all spans associated with a specific thread.
   * @param threadId - The thread identifier to filter spans by
   * @returns Array of spans for the given thread
   */
  getSpansForThread(threadId: string): ReadableSpan[] {
    const spanMap = new Map<string, ReadableSpan>();

    // Index all spans by ID
    for (const span of this.spans) {
      spanMap.set(span.spanContext().spanId, span);
    }

    // Check if span or any ancestor belongs to thread
    const belongsToThread = (span: ReadableSpan, visited = new Set<string>()): boolean => {
      const spanId = span.spanContext().spanId;
      if (visited.has(spanId)) return false;
      visited.add(spanId);

      if (span.attributes[attributes.ATTR_LANGWATCH_THREAD_ID] === threadId) {
        return true;
      }
      const parentId = getParentSpanId(span);
      if (parentId && spanMap.has(parentId)) {
        return belongsToThread(spanMap.get(parentId)!, visited);
      }
      return false;
    };

    return this.spans.filter((span) => belongsToThread(span));
  }
}

/**
 * Extracts the parent span ID from a ReadableSpan, handling both OTel SDK v2
 * (parentSpanId: string) and v1 (parentSpanContext: SpanContext) interfaces.
 * The LangWatch SDK's internal spans still use the v1 parentSpanContext field.
 */
function getParentSpanId(span: ReadableSpan): string | undefined {
  if (span.parentSpanId) return span.parentSpanId;
  // Fall back to v1 API used by LangWatch SDK's span implementation
  const legacy = (span as unknown as Record<string, unknown>).parentSpanContext as
    | { spanId?: string }
    | undefined;
  return legacy?.spanId;
}

/**
 * Singleton instance of the judge span collector.
 */
export const judgeSpanCollector = new JudgeSpanCollector();
