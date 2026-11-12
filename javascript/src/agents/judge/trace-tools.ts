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
/** Characters of context kept on each side of a grep match. */
const GREP_CONTEXT_CHARS = 400;
/** Maximum windows shown per matching line. */
const MAX_WINDOWS_PER_LINE = 5;

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
    `[${node.shortId}] ${timestamp} ${span.name} (${formatDuration(duration)})${status}`
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
    "\n\n[TRUNCATED] Output exceeded ~4000 token budget. Use grep_trace(pattern) to search for specific content, or expand_trace with fewer span IDs."
  );
}

/**
 * One page of an expand_trace result, starting at `offset` characters. The
 * footer names the offset of the next page, so content past the budget stays
 * reachable.
 */
function pageToCharBudget(text: string, offset: number): string {
  const start = Math.max(0, Math.min(Math.floor(offset), text.length));
  if (start === 0 && text.length <= TOOL_RESULT_CHAR_BUDGET) return text;
  const end = Math.min(start + TOOL_RESULT_CHAR_BUDGET, text.length);
  const header =
    start > 0 ? `[Showing characters ${start}-${end} of ${text.length}]\n` : "";
  const footer =
    end < text.length
      ? `\n\n[TRUNCATED] Showing characters ${start}-${end} of ${text.length}: ${text.length - end} more characters of these spans are not shown, so do not conclude that something is absent from them. Call expand_trace with the same span IDs and offset=${end} to read on, or grep_trace(pattern) to jump to specific content.`
      : "";
  return header + text.slice(start, end) + footer;
}

/**
 * The parts of a long line around each match of `regex`, so a match deep
 * inside one long attribute (retrieved documents serialized as one JSON
 * value) is shown instead of being cut off by the result budget.
 */
function matchWindows(line: string, regex: RegExp): string[] {
  if (line.length <= GREP_CONTEXT_CHARS * 2) return [line];
  const global = new RegExp(regex.source, "gi");
  const windows: string[] = [];
  let lastEnd = -1;
  for (const match of line.matchAll(global)) {
    if (windows.length >= MAX_WINDOWS_PER_LINE) break;
    const at = match.index ?? 0;
    if (at < lastEnd) continue;
    const start = Math.max(0, at - GREP_CONTEXT_CHARS);
    const end = Math.min(line.length, at + match[0].length + GREP_CONTEXT_CHARS);
    windows.push(
      `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""} [match at character ${at} of ${line.length}]`
    );
    lastEnd = end;
  }
  return windows;
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
 * Spans are matched by prefix: the caller can pass the truncated 8-char
 * span ID shown in the skeleton and it will match any span whose full ID
 * starts with that prefix.
 *
 * @param spans - The full array of ReadableSpan objects for the trace
 * @param spanIds - Span IDs or prefixes to expand
 * @param offset - Character offset of the page to return, for long spans
 * @returns Formatted string with full span details, one ~4096 token page
 */
export function expandTrace(
  spans: ReadableSpan[],
  spanIds: string[],
  offset = 0
): string {
  const nodes = indexSpans(spans);

  if (nodes.length === 0) {
    return "No spans recorded.";
  }

  if (spanIds.length === 0) {
    return "Error: provide at least one span ID.";
  }

  // Match nodes by prefix
  const selected = nodes.filter((n) => {
    const fullId = n.span.spanContext().spanId;
    return spanIds.some((prefix) => fullId.startsWith(prefix));
  });

  if (selected.length === 0) {
    const available = nodes.map((n) => n.shortId).join(", ");
    return `Error: no spans matched the given ID(s). Available span IDs: ${available}`;
  }

  const lines: string[] = [];
  for (const node of selected) {
    const spanLines = renderFullSpanNode(node);
    lines.push(...spanLines);
    lines.push("");
  }

  return pageToCharBudget(lines.join("\n").trimEnd(), offset);
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
      `--- [${node.shortId}] ${node.span.name} (${formatDuration(duration)}) ---`
    );
    for (const line of matchingLines) {
      for (const window of matchWindows(line, regex)) {
        lines.push(`  ${window}`);
      }
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
