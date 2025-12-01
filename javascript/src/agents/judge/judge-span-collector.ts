import { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";

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
    const belongsToThread = (span: ReadableSpan): boolean => {
      if (span.attributes["langwatch.thread.id"] === threadId) {
        return true;
      }
      const parentId = span.parentSpanContext?.spanId;
      if (parentId && spanMap.has(parentId)) {
        return belongsToThread(spanMap.get(parentId)!);
      }
      return false;
    };

    return this.spans.filter(belongsToThread);
  }
}

/**
 * Singleton instance of the judge span collector.
 */
export const judgeSpanCollector = new JudgeSpanCollector();
