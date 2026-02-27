import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import {
  type SpanNode,
  hrTimeToMs,
  formatDuration,
  calculateSpanDuration,
  getStatusIndicator,
  cleanAttributes,
  formatValue,
  indexSpans,
} from "./span-utils";

/** Maximum estimated tokens for a single tool result. */
const TOOL_RESULT_TOKEN_BUDGET = 4096;
/** Maximum characters for a single tool result (~4000 tokens * 4 chars). */
const TOOL_RESULT_CHAR_BUDGET = TOOL_RESULT_TOKEN_BUDGET * 4;
/** Maximum number of grep matches returned. */
const MAX_GREP_MATCHES = 20;

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * Renders full details for a single span node (attributes, events, status).
 */
function renderFullSpanNode(node: SpanNode): string[] {
  const span = node.span;
  const duration = calculateSpanDuration(span);
  const timestamp = new Date(hrTimeToMs(span.startTime)).toISOString();
  const status = getStatusIndicator(span);

  const lines: string[] = [];
  lines.push(
    `[${node.index}] ${timestamp} ${span.name} (${formatDuration(duration)})${status}`
  );

  const attrs = cleanAttributes(span.attributes);
  if (Object.keys(attrs).length > 0) {
    for (const [key, value] of Object.entries(attrs)) {
      lines.push(`    ${key}: ${formatValue(value)}`);
    }
  }

  if (span.events.length > 0) {
    for (const event of span.events) {
      lines.push(`    [event] ${event.name}`);
      if (event.attributes) {
        const eventAttrs = cleanAttributes(event.attributes);
        for (const [key, value] of Object.entries(eventAttrs)) {
          lines.push(`      ${key}: ${formatValue(value)}`);
        }
      }
    }
  }

  return lines;
}

/**
 * Truncates text to fit within the tool result character budget.
 */
function truncateToCharBudget(text: string): string {
  if (text.length <= TOOL_RESULT_CHAR_BUDGET) return text;
  const truncated = text.slice(0, TOOL_RESULT_CHAR_BUDGET);
  return (
    truncated +
    "\n\n[TRUNCATED] Output exceeded ~4000 token budget. Use grep_trace(pattern) to search for specific content, or expand_trace with a narrower range."
  );
}

/**
 * Serializes a span to a single searchable string for grep matching.
 */
function spanToSearchableText(span: ReadableSpan): string {
  const parts: string[] = [span.name];

  const attrs = cleanAttributes(span.attributes);
  for (const [key, value] of Object.entries(attrs)) {
    parts.push(`${key}: ${formatValue(value)}`);
  }

  for (const event of span.events) {
    parts.push(event.name);
    if (event.attributes) {
      const eventAttrs = cleanAttributes(event.attributes);
      for (const [key, value] of Object.entries(eventAttrs)) {
        parts.push(`${key}: ${formatValue(value)}`);
      }
    }
  }

  return parts.join("\n");
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Expands one or more spans from a trace, returning their full details
 * (attributes, events, status) with tree position context.
 *
 * @param spans - The full array of ReadableSpan objects for the trace
 * @param options - Either a single `index` or a `range` string like "10-15"
 * @returns Formatted string with full span details, truncated to ~4000 tokens
 */
export function expandTrace(
  spans: ReadableSpan[],
  { index, range }: { index?: number; range?: string }
): string {
  const nodes = indexSpans(spans);

  if (nodes.length === 0) {
    return "No spans recorded.";
  }

  // Parse range into start/end indices
  let startIdx: number;
  let endIdx: number;

  if (range != null) {
    const parts = range.split("-").map(Number);
    startIdx = parts[0]!;
    endIdx = parts[1] ?? startIdx;
  } else if (index != null) {
    startIdx = index;
    endIdx = index;
  } else {
    return "Error: provide either index or range parameter.";
  }

  const maxIndex = nodes.length;
  if (startIdx < 1 || endIdx > maxIndex || startIdx > endIdx) {
    return `Error: span index out of range. Valid range is 1-${maxIndex}.`;
  }

  // Find the requested nodes by index
  const selected = nodes.filter(
    (n) => n.index >= startIdx && n.index <= endIdx
  );

  const lines: string[] = [];
  for (const node of selected) {
    const spanLines = renderFullSpanNode(node);
    lines.push(...spanLines);
    lines.push("");
  }

  return truncateToCharBudget(lines.join("\n").trimEnd());
}

/**
 * Searches across all span attributes, events, and content for a pattern.
 * Returns matching spans with their tree position and matching content.
 *
 * @param spans - The full array of ReadableSpan objects for the trace
 * @param pattern - Case-insensitive search pattern
 * @returns Formatted string with matches, limited to 20 results and ~4000 tokens
 */
export function grepTrace(spans: ReadableSpan[], pattern: string): string {
  const nodes = indexSpans(spans);

  if (nodes.length === 0) {
    return "No spans recorded.";
  }

  const regex = new RegExp(escapeRegex(pattern), "i");
  const matches: { node: SpanNode; matchingLines: string[] }[] = [];

  for (const node of nodes) {
    const searchText = spanToSearchableText(node.span);
    const lines = searchText.split("\n");
    const matchingLines = lines.filter((line) => regex.test(line));

    if (matchingLines.length > 0) {
      matches.push({ node, matchingLines });
    }
  }

  if (matches.length === 0) {
    const spanNames = Array.from(new Set(nodes.map((n) => n.span.name)));
    return `No matches found for "${pattern}". Available span names: ${spanNames.join(", ")}`;
  }

  const totalMatches = matches.length;
  const limited = matches.slice(0, MAX_GREP_MATCHES);

  const lines: string[] = [];
  for (const { node, matchingLines } of limited) {
    const duration = calculateSpanDuration(node.span);
    lines.push(
      `--- [${node.index}] ${node.span.name} (${formatDuration(duration)}) ---`
    );
    for (const line of matchingLines) {
      lines.push(`  ${line}`);
    }
    lines.push("");
  }

  if (totalMatches > MAX_GREP_MATCHES) {
    lines.push(
      `[${totalMatches - MAX_GREP_MATCHES} more matches omitted. Refine your search pattern for more specific results.]`
    );
  }

  return truncateToCharBudget(lines.join("\n").trimEnd());
}

/**
 * Escapes special regex characters in a string for safe use in RegExp constructor.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
