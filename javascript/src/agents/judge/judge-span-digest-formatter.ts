import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import {
  hrTimeToMs,
  formatDuration,
  calculateSpanDuration,
  getStatusIndicator,
  getTokenUsage,
  cleanAttributes,
  looksLikeJson,
} from "./span-utils";
import { StringDeduplicator } from "./string-deduplicator";
import { truncateMediaUrl, truncateMediaPart } from "./truncate-media";
import { deepTransform } from "./deep-transform";
import { Logger } from "../../utils/logger";

/**
 * Represents a span node in the formatter's hierarchy tree.
 * Unlike the shared SpanNode, this does not include an `index` field;
 * sequence numbers are computed during rendering via a running counter.
 */
interface FormatterSpanNode {
  span: ReadableSpan;
  children: FormatterSpanNode[];
}

/**
 * Transforms OpenTelemetry spans into a complete plain-text digest for judge evaluation.
 * Deduplicates repeated string content to reduce token usage.
 */
export class JudgeSpanDigestFormatter {
  private readonly logger = new Logger("JudgeSpanDigestFormatter");
  private readonly deduplicator = new StringDeduplicator({ threshold: 50 });

  /**
   * Formats spans into a structure-only digest showing span tree hierarchy
   * without attributes, events, or content. Used for large traces that
   * exceed the token threshold, paired with expand_trace/grep_trace tools.
   *
   * @param spans - All spans for a thread
   * @returns Plain text digest with only structural information
   */
  formatStructureOnly(spans: ReadableSpan[]): string {
    this.logger.debug("formatStructureOnly() called", {
      spanCount: spans.length,
    });

    if (spans.length === 0) {
      return "No spans recorded.";
    }

    const sortedSpans = this.sortByStartTime(spans);
    const tree = this.buildHierarchy(sortedSpans);
    const totalDuration = this.calculateTotalDuration(sortedSpans);

    const lines: string[] = [
      `Spans: ${spans.length} | Total Duration: ${formatDuration(totalDuration)}`,
      "",
    ];

    let sequence = 1;
    const rootCount = tree.length;
    tree.forEach((node, idx) => {
      sequence = this.renderStructureNode(
        node,
        lines,
        0,
        sequence,
        idx === rootCount - 1
      );
    });

    const errors = this.collectErrors(spans);
    if (errors.length > 0) {
      lines.push("");
      lines.push("=== ERRORS ===");
      errors.forEach((e) => lines.push(e));
    }

    return lines.join("\n");
  }

  /**
   * Formats spans into a complete digest with full content and nesting.
   * @param spans - All spans for a thread
   * @returns Plain text digest
   */
  format(spans: ReadableSpan[]): string {
    this.deduplicator.reset();

    this.logger.debug("format() called", {
      spanCount: spans.length,
      spanNames: spans.map((s) => s.name),
    });

    if (spans.length === 0) {
      this.logger.debug("No spans to format");
      return "No spans recorded.";
    }

    const sortedSpans = this.sortByStartTime(spans);
    const tree = this.buildHierarchy(sortedSpans);
    const totalDuration = this.calculateTotalDuration(sortedSpans);

    this.logger.debug("Hierarchy built", {
      rootCount: tree.length,
      totalDuration,
    });

    const lines: string[] = [
      `Spans: ${spans.length} | Total Duration: ${formatDuration(
        totalDuration
      )}`,
      "",
    ];

    let sequence = 1;
    const rootCount = tree.length;
    tree.forEach((node, idx) => {
      sequence = this.renderNode(
        node,
        lines,
        0,
        sequence,
        idx === rootCount - 1
      );
    });

    const errors = this.collectErrors(spans);
    if (errors.length > 0) {
      lines.push("");
      lines.push("=== ERRORS ===");
      errors.forEach((e) => lines.push(e));
    }

    return lines.join("\n");
  }

  private sortByStartTime(spans: ReadableSpan[]): ReadableSpan[] {
    return [...spans].sort((a, b) => {
      return hrTimeToMs(a.startTime) - hrTimeToMs(b.startTime);
    });
  }

  private buildHierarchy(spans: ReadableSpan[]): FormatterSpanNode[] {
    const spanMap = new Map<string, FormatterSpanNode>();
    const roots: FormatterSpanNode[] = [];

    for (const span of spans) {
      spanMap.set(span.spanContext().spanId, { span, children: [] });
    }

    for (const span of spans) {
      const node = spanMap.get(span.spanContext().spanId)!;
      const parentId = getParentSpanId(span);

      if (parentId && spanMap.has(parentId)) {
        spanMap.get(parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  private renderStructureNode(
    node: FormatterSpanNode,
    lines: string[],
    depth: number,
    sequence: number,
    isLast: boolean = true
  ): number {
    const span = node.span;
    const duration = calculateSpanDuration(span);
    const timestamp = new Date(hrTimeToMs(span.startTime)).toISOString();
    const status = getStatusIndicator(span);
    const tokens = getTokenUsage(span);

    const prefix = this.getTreePrefix(depth, isLast);
    lines.push(
      `${prefix}[${sequence}] ${timestamp} ${
        span.name
      } (${formatDuration(duration)}${tokens})${status}`
    );
    lines.push("");

    let nextSeq = sequence + 1;
    const childCount = node.children.length;
    node.children.forEach((child, idx) => {
      nextSeq = this.renderStructureNode(
        child,
        lines,
        depth + 1,
        nextSeq,
        idx === childCount - 1
      );
    });

    return nextSeq;
  }

  private renderNode(
    node: FormatterSpanNode,
    lines: string[],
    depth: number,
    sequence: number,
    isLast: boolean = true
  ): number {
    const span = node.span;
    const duration = calculateSpanDuration(span);
    const timestamp = new Date(hrTimeToMs(span.startTime)).toISOString();
    const status = getStatusIndicator(span);

    const prefix = this.getTreePrefix(depth, isLast);
    lines.push(
      `${prefix}[${sequence}] ${timestamp} ${
        span.name
      } (${formatDuration(duration)})${status}`
    );

    const attrIndent = this.getAttrIndent(depth, isLast);
    const attrs = cleanAttributes(span.attributes);
    if (Object.keys(attrs).length > 0) {
      for (const [key, value] of Object.entries(attrs)) {
        lines.push(`${attrIndent}${key}: ${this.formatValueWithDedup(value)}`);
      }
    }

    if (span.events.length > 0) {
      for (const event of span.events) {
        lines.push(`${attrIndent}[event] ${event.name}`);
        if (event.attributes) {
          const eventAttrs = cleanAttributes(event.attributes);
          for (const [key, value] of Object.entries(eventAttrs)) {
            lines.push(`${attrIndent}  ${key}: ${this.formatValueWithDedup(value)}`);
          }
        }
      }
    }

    lines.push("");

    let nextSeq = sequence + 1;
    const childCount = node.children.length;
    node.children.forEach((child, idx) => {
      nextSeq = this.renderNode(
        child,
        lines,
        depth + 1,
        nextSeq,
        idx === childCount - 1
      );
    });

    return nextSeq;
  }

  private getTreePrefix(depth: number, isLast: boolean): string {
    if (depth === 0) return "";
    const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
    return "\u2502   ".repeat(depth - 1) + connector;
  }

  private getAttrIndent(depth: number, isLast: boolean): string {
    if (depth === 0) return "    ";
    const continuation = isLast ? "    " : "\u2502   ";
    return "\u2502   ".repeat(depth - 1) + continuation + "    ";
  }

  /**
   * Formats a value with deduplication applied. Used by the `format()` method
   * to reduce token usage by replacing repeated strings with markers.
   */
  private formatValueWithDedup(value: unknown): string {
    const processed = this.transformValueWithDedup(value);
    return typeof processed === "string"
      ? processed
      : JSON.stringify(processed);
  }

  private transformValueWithDedup(value: unknown): unknown {
    return deepTransform(value, (v) => {
      const mediaPart = truncateMediaPart(v);
      if (mediaPart) return mediaPart;
      if (typeof v !== "string") return v;
      return this.transformStringWithDedup(v);
    });
  }

  private transformStringWithDedup(str: string): string {
    if (looksLikeJson(str)) {
      try {
        const processed = this.transformValueWithDedup(JSON.parse(str));
        return JSON.stringify(processed);
      } catch {
        /* not valid JSON */
      }
    }

    const truncated = truncateMediaUrl(str);
    if (truncated !== str) return truncated;

    return this.deduplicator.process(str);
  }

  private calculateTotalDuration(spans: ReadableSpan[]): number {
    if (spans.length === 0) return 0;
    const first = hrTimeToMs(spans[0].startTime);
    const last = Math.max(...spans.map((s) => hrTimeToMs(s.endTime)));
    return last - first;
  }

  private collectErrors(spans: ReadableSpan[]): string[] {
    return spans
      .filter((s) => s.status.code === 2)
      .map((s) => `- ${s.name}: ${s.status.message ?? "unknown error"}`);
  }
}

/**
 * Extracts the parent span ID from a ReadableSpan, handling both OTel SDK v2
 * (parentSpanId: string) and v1 (parentSpanContext: SpanContext) interfaces.
 * The LangWatch SDK's internal spans still use the v1 parentSpanContext field.
 */
function getParentSpanId(span: ReadableSpan): string | undefined {
  if (span.parentSpanId) return span.parentSpanId;
  const legacy = (span as unknown as Record<string, unknown>).parentSpanContext as
    | { spanId?: string }
    | undefined;
  return legacy?.spanId;
}

/**
 * Singleton instance for convenience.
 */
export const judgeSpanDigestFormatter = new JudgeSpanDigestFormatter();
