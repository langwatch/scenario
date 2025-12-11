import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { deepTransform } from "./deep-transform";
import { StringDeduplicator } from "./string-deduplicator";
import { truncateMediaUrl, truncateMediaPart } from "./truncate-media";
import { Logger } from "../../utils/logger";

/**
 * Represents a span node in the hierarchy tree.
 */
interface SpanNode {
  span: ReadableSpan;
  children: SpanNode[];
}

/**
 * Transforms OpenTelemetry spans into a complete plain-text digest for judge evaluation.
 * Deduplicates repeated string content to reduce token usage.
 */
export class JudgeSpanDigestFormatter {
  private readonly logger = new Logger("JudgeSpanDigestFormatter");
  private readonly deduplicator = new StringDeduplicator({ threshold: 50 });

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
      `Spans: ${spans.length} | Total Duration: ${this.formatDuration(
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
      const aTime = this.hrTimeToMs(a.startTime);
      const bTime = this.hrTimeToMs(b.startTime);
      return aTime - bTime;
    });
  }

  private buildHierarchy(spans: ReadableSpan[]): SpanNode[] {
    const spanMap = new Map<string, SpanNode>();
    const roots: SpanNode[] = [];

    for (const span of spans) {
      spanMap.set(span.spanContext().spanId, { span, children: [] });
    }

    for (const span of spans) {
      const node = spanMap.get(span.spanContext().spanId)!;
      const parentId = span.parentSpanContext?.spanId;

      if (parentId && spanMap.has(parentId)) {
        spanMap.get(parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  private renderNode(
    node: SpanNode,
    lines: string[],
    depth: number,
    sequence: number,
    isLast: boolean = true
  ): number {
    const span = node.span;
    const duration = this.calculateSpanDuration(span);
    const timestamp = this.formatTimestamp(span.startTime);
    const status = this.getStatusIndicator(span);

    const prefix = this.getTreePrefix(depth, isLast);
    lines.push(
      `${prefix}[${sequence}] ${new Date(timestamp).toISOString()} ${
        span.name
      } (${this.formatDuration(duration)})${status}`
    );

    const attrIndent = this.getAttrIndent(depth, isLast);
    const attrs = this.cleanAttributes(span.attributes);
    if (Object.keys(attrs).length > 0) {
      for (const [key, value] of Object.entries(attrs)) {
        lines.push(`${attrIndent}${key}: ${this.formatValue(value)}`);
      }
    }

    if (span.events.length > 0) {
      for (const event of span.events) {
        lines.push(`${attrIndent}[event] ${event.name}`);
        if (event.attributes) {
          const eventAttrs = this.cleanAttributes(event.attributes);
          for (const [key, value] of Object.entries(eventAttrs)) {
            lines.push(`${attrIndent}  ${key}: ${this.formatValue(value)}`);
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
    const connector = isLast ? "└── " : "├── ";
    return "│   ".repeat(depth - 1) + connector;
  }

  private getAttrIndent(depth: number, isLast: boolean): string {
    if (depth === 0) return "    ";
    const continuation = isLast ? "    " : "│   ";
    return "│   ".repeat(depth - 1) + continuation + "    ";
  }

  private cleanAttributes(
    attrs: Record<string, unknown>
  ): Record<string, unknown> {
    const cleaned: Record<string, unknown> = {};
    const seen = new Set<string>();

    for (const [key, value] of Object.entries(attrs)) {
      const cleanKey = key.replace(/^(langwatch)\./, "");
      if (["thread.id", "scenario.id", "scenario.name"].includes(cleanKey)) {
        continue;
      }
      if (!seen.has(cleanKey)) {
        seen.add(cleanKey);
        cleaned[cleanKey] = value;
      }
    }

    return cleaned;
  }

  private formatValue(value: unknown): string {
    const processed = this.transformValue(value);
    return typeof processed === "string"
      ? processed
      : JSON.stringify(processed);
  }

  private transformValue(value: unknown): unknown {
    return deepTransform(value, (v) => {
      // AI SDK media parts — special objects
      const mediaPart = truncateMediaPart(v);
      if (mediaPart) return mediaPart;

      // Not a string → continue traversal
      if (typeof v !== "string") return v;

      // String transforms
      return this.transformString(v);
    });
  }

  private transformString(str: string): string {
    // JSON strings — parse and recurse
    if (this.looksLikeJson(str)) {
      try {
        const processed = this.transformValue(JSON.parse(str));
        return JSON.stringify(processed);
      } catch {
        /* not valid JSON */
      }
    }

    // Data URLs → marker
    const truncated = truncateMediaUrl(str);
    if (truncated !== str) return truncated;

    // Dedup
    return this.deduplicator.process(str);
  }

  private looksLikeJson(str: string): boolean {
    const t = str.trim();
    return (
      (t.startsWith("{") && t.endsWith("}")) ||
      (t.startsWith("[") && t.endsWith("]"))
    );
  }

  private hrTimeToMs(hrTime: [number, number]): number {
    return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
  }

  private calculateSpanDuration(span: ReadableSpan): number {
    return this.hrTimeToMs(span.endTime) - this.hrTimeToMs(span.startTime);
  }

  private calculateTotalDuration(spans: ReadableSpan[]): number {
    if (spans.length === 0) return 0;
    const first = this.hrTimeToMs(spans[0].startTime);
    const last = Math.max(...spans.map((s) => this.hrTimeToMs(s.endTime)));
    return last - first;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  private formatTimestamp(hrTime: [number, number]): string {
    const ms = this.hrTimeToMs(hrTime);
    return new Date(ms).toISOString();
  }

  private getStatusIndicator(span: ReadableSpan): string {
    if (span.status.code === 2) {
      return ` ⚠️ ERROR: ${span.status.message ?? "unknown"}`;
    }
    return "";
  }

  private collectErrors(spans: ReadableSpan[]): string[] {
    return spans
      .filter((s) => s.status.code === 2)
      .map((s) => `- ${s.name}: ${s.status.message ?? "unknown error"}`);
  }
}

/**
 * Singleton instance for convenience.
 */
export const judgeSpanDigestFormatter = new JudgeSpanDigestFormatter();
