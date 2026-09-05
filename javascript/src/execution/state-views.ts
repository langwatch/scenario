/**
 * Views the scenario state exposes over the run: the text of messages, the
 * tool calls merged from the messages and the spans, the retrieved contexts,
 * and the spans grouped by trace and by turn.
 *
 * Every view reports what it read to a {@link StateReadReporter}, so the
 * evaluator runner knows when a mapping read the trace and what it missed.
 */
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { ModelMessage } from "ai";

/** One call of a tool during the run. */
export interface ToolCall {
  name: string;
  /** The arguments of the call. */
  input: unknown;
  /** The result of the call, when known. */
  output: unknown;
  /** The index of the turn the call belongs to, in `state.turns`. */
  turn: number | undefined;
  /** Whether the call came from an assistant message or from a tool span. */
  source: "message" | "span";
}

/** What a view reports about what it read and what it missed. */
export interface StateReadReporter {
  noteTrace(): void;
  noteMissingToolCall(name: string): void;
  noteEmptyContexts(): void;
}

/** What one mapping read from the state, and what it found missing. */
export interface StateReads {
  /** The mapping read the spans, the traces, the contexts or the tool calls. */
  trace: boolean;
  /** Fields the mapping read that the scenario leaves blank. */
  blankFields: string[];
  /** Tool names the mapping asked for that no message or span carries. */
  missingToolCalls: string[];
  /** The mapping read the contexts and the trace holds none. */
  emptyContexts: boolean;
}

/**
 * The calls of one tool during the run, in start order. An array with the
 * picks `first` and `last` and the columns `inputs` and `outputs`.
 */
export class ToolCalls extends Array<ToolCall> {
  static get [Symbol.species]() {
    return Array;
  }

  static collect(calls: ToolCall[]): ToolCalls {
    const collection = new ToolCalls();
    collection.push(...calls);
    return collection;
  }

  /** The first call, or nothing when the tool was never called. */
  get first(): ToolCall | undefined {
    return this[0];
  }

  /** The last call, or nothing when the tool was never called. */
  get last(): ToolCall | undefined {
    return this[this.length - 1];
  }

  /** The input of every call, in order. */
  get inputs(): unknown[] {
    return this.map((call) => call.input);
  }

  /** The output of every call, in order. */
  get outputs(): unknown[] {
    return this.map((call) => call.output);
  }
}

/** One trace of the run: every span of it and the tool calls it holds. */
export interface TraceView {
  readonly id: string;
  /** The spans of the trace collected so far, in start order. */
  readonly spans: ReadableSpan[];
  /** The tool calls of this trace, from its messages and its spans. */
  toolCalls(name?: string): ToolCalls;
}

/** One turn of the run: its messages, its trace and the tool calls it holds. */
export interface TurnView {
  /** The position of the turn in `state.turns`. */
  readonly index: number;
  /** The messages added during the turn. */
  readonly messages: ModelMessage[];
  /** The trace of the turn, when its messages carry a trace id. */
  readonly trace: TraceView | undefined;
  /** The tool calls of this turn, from its messages and its spans. */
  toolCalls(name?: string): ToolCalls;
}

type StampedMessage = ModelMessage & { traceId?: string; turn?: number };

const TOOL_SPAN_TYPE = "tool";
const SPAN_TYPE_ATTRIBUTES = ["langwatch.span.type"];
const TOOL_NAME_ATTRIBUTES = ["gen_ai.tool.name"];
const INPUT_ATTRIBUTES = ["langwatch.input", "gen_ai.tool.call.arguments"];
const OUTPUT_ATTRIBUTES = ["langwatch.output", "gen_ai.tool.call.result"];
const CONTEXT_ATTRIBUTES = [
  "langwatch.rag_contexts",
  "langwatch.rag.contexts",
  "retrieval.documents",
];

export function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Text of a message: the string content, or the text parts joined. Tool
 * calls and tool results render as their JSON so a transcript keeps them.
 */
export function messageText(message: ModelMessage): string {
  const content = message.content as unknown;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringify(content);
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part) {
        if (part.type === "text" && "text" in part) return String(part.text);
        if (part.type === "tool-call" || part.type === "tool-result") {
          return stringify(part);
        }
      }
      return stringify(part);
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/** The conversation as one `role: content` line per message. */
export function transcript(messages: ModelMessage[]): string {
  return messages.map((m) => `${m.role}: ${messageText(m)}`).join("\n");
}

function attribute(span: ReadableSpan, keys: string[]): unknown {
  const attributes = span.attributes ?? {};
  for (const key of keys) {
    const value = attributes[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function spanStartMs(span: ReadableSpan): number {
  const start = span.startTime;
  if (!start) return 0;
  return start[0] * 1000 + start[1] / 1_000_000;
}

function spanTraceId(span: ReadableSpan): string | undefined {
  try {
    return span.spanContext().traceId;
  } catch {
    return undefined;
  }
}

/** Spans in start order. */
export function sortSpans(spans: ReadableSpan[]): ReadableSpan[] {
  return [...spans].sort((a, b) => spanStartMs(a) - spanStartMs(b));
}

/** Distinct trace ids on the messages, in first-seen order. */
export function messageTraceIds(messages: ModelMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages as StampedMessage[]) {
    const traceId = message.traceId;
    if (typeof traceId !== "string" || traceId.length === 0) continue;
    if (!ids.includes(traceId)) ids.push(traceId);
  }
  return ids;
}

/** The retrieved contexts of every rag span, in start order. */
export function spanContexts(spans: ReadableSpan[]): string[] {
  const contexts: string[] = [];
  for (const span of sortSpans(spans)) {
    const raw = attribute(span, CONTEXT_ATTRIBUTES);
    if (raw === undefined) continue;
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === "object" && "content" in item) {
          contexts.push(stringify((item as { content: unknown }).content));
        } else {
          contexts.push(stringify(item));
        }
      }
    } else {
      contexts.push(stringify(parsed));
    }
  }
  return contexts;
}

interface ToolCallRecord extends ToolCall {
  traceId: string | undefined;
}

/**
 * Tool calls the agent returned in its messages: every `tool-call` part of an
 * assistant message, joined to the `tool-result` part with the same call id.
 */
function messageToolCalls({
  messages,
  turnOfMessage,
}: {
  messages: ModelMessage[];
  turnOfMessage: WeakMap<object, number>;
}): ToolCallRecord[] {
  const outputs = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-result") outputs.set(part.toolCallId, part.output);
    }
  }
  const calls: ToolCallRecord[] = [];
  for (const message of messages as StampedMessage[]) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      calls.push({
        name: part.toolName,
        input: part.input,
        output: outputs.get(part.toolCallId),
        turn: turnOfMessage.get(message),
        source: "message",
        traceId: message.traceId,
      });
    }
  }
  return calls;
}

/** Tool spans, in start order, each attributed to the turn of its trace. */
function spanToolCalls({
  spans,
  turnOfTrace,
}: {
  spans: ReadableSpan[];
  turnOfTrace: Map<string, number>;
}): ToolCallRecord[] {
  return sortSpans(spans)
    .filter((span) => attribute(span, SPAN_TYPE_ATTRIBUTES) === TOOL_SPAN_TYPE)
    .map((span) => {
      const traceId = spanTraceId(span);
      return {
        name: String(attribute(span, TOOL_NAME_ATTRIBUTES) ?? span.name),
        input: attribute(span, INPUT_ATTRIBUTES),
        output: attribute(span, OUTPUT_ATTRIBUTES),
        turn: traceId === undefined ? undefined : turnOfTrace.get(traceId),
        source: "span" as const,
        traceId,
      };
    });
}

function canonical(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return stringify(value);
}

/** True when a span describes the same call as a message tool call. */
function sameCall(a: ToolCallRecord, b: ToolCallRecord): boolean {
  if (a.name !== b.name) return false;
  if (a.turn !== undefined && b.turn !== undefined && a.turn !== b.turn) return false;
  return canonical(a.input) === canonical(b.input);
}

/**
 * Merges message tool calls and span tool calls by name, in start order:
 * turn by turn, the message calls of a turn before its span calls. A span
 * that describes a call the messages already carry is not listed twice; it
 * fills in the output when the messages have none. Each message call is
 * described by at most one span, so a repeated call with the same
 * arguments stays a distinct call.
 */
export function mergeToolCalls({
  messages,
  spans,
  allMessages,
  name,
}: {
  /** The messages whose tool calls to list. */
  messages: ModelMessage[];
  /** The spans whose tool calls to list. */
  spans: ReadableSpan[];
  /** Every message of the run, which decides the turn of each message and trace. */
  allMessages: ModelMessage[];
  name?: string;
}): ToolCall[] {
  const turnOfMessage = turnOfMessageMap(allMessages);
  const fromMessages = messageToolCalls({ messages, turnOfMessage });
  const fromSpans = spanToolCalls({ spans, turnOfTrace: turnOfTraceMap(allMessages) });
  const merged: ToolCallRecord[] = [...fromMessages];
  const described = new Set<ToolCallRecord>();
  for (const spanCall of fromSpans) {
    const twin = merged.find(
      (call) => call.source === "message" && !described.has(call) && sameCall(call, spanCall)
    );
    if (twin) {
      described.add(twin);
      if (twin.output === undefined && spanCall.output !== undefined) {
        twin.output = spanCall.output;
      }
      continue;
    }
    merged.push(spanCall);
  }
  const rank = (call: ToolCallRecord) => (call.turn === undefined ? Number.MAX_SAFE_INTEGER : call.turn);
  const ordered = merged
    .map((call, sequence) => ({ call, sequence }))
    .sort((a, b) => {
      const byTurn = rank(a.call) - rank(b.call);
      if (byTurn !== 0) return byTurn;
      const bySource = (a.call.source === "span" ? 1 : 0) - (b.call.source === "span" ? 1 : 0);
      if (bySource !== 0) return bySource;
      return a.sequence - b.sequence;
    })
    .map(({ call }) => call);
  return ordered
    .filter((call) => name === undefined || call.name === name)
    .map(({ name: callName, input, output, turn, source }) => ({
      name: callName,
      input,
      output,
      turn,
      source,
    }));
}

/**
 * The position in `state.turns` of every message, from the turn stamps the
 * executor puts on them. A message without a stamp joins the turn of the
 * message before it.
 */
function turnOfMessageMap(messages: ModelMessage[]): WeakMap<object, number> {
  const map = new WeakMap<object, number>();
  const stamps: number[] = [];
  for (const message of messages as StampedMessage[]) {
    const stamp = message.turn ?? stamps[stamps.length - 1] ?? 0;
    if (!stamps.includes(stamp)) stamps.push(stamp);
    map.set(message, stamps.indexOf(stamp));
  }
  return map;
}

/** The turn each trace id belongs to, from the messages that carry it. */
function turnOfTraceMap(messages: ModelMessage[]): Map<string, number> {
  const map = new Map<string, number>();
  const turnOfMessage = turnOfMessageMap(messages);
  for (const message of messages as StampedMessage[]) {
    if (!message.traceId || map.has(message.traceId)) continue;
    const index = turnOfMessage.get(message);
    if (index !== undefined) map.set(message.traceId, index);
  }
  return map;
}

/** What the trace and turn views read from the state. */
export interface StateViewSource {
  messages: ModelMessage[];
  spans: ReadableSpan[];
  reporter: StateReadReporter;
}

function collectToolCalls({
  source,
  messages,
  spans,
  name,
}: {
  source: StateViewSource;
  messages: ModelMessage[];
  spans: ReadableSpan[];
  name?: string;
}): ToolCalls {
  source.reporter.noteTrace();
  const calls = ToolCalls.collect(
    mergeToolCalls({ messages, spans, allMessages: source.messages, name })
  );
  if (name !== undefined && calls.length === 0) source.reporter.noteMissingToolCall(name);
  return calls;
}

/** Every tool call of the run, or the calls of one tool. */
export function runToolCalls(source: StateViewSource, name?: string): ToolCalls {
  return collectToolCalls({ source, messages: source.messages, spans: source.spans, name });
}

/** The retrieved contexts of the run. */
export function runContexts(source: StateViewSource): string[] {
  source.reporter.noteTrace();
  const contexts = spanContexts(source.spans);
  if (contexts.length === 0) source.reporter.noteEmptyContexts();
  return contexts;
}

function traceView({ source, id }: { source: StateViewSource; id: string }): TraceView {
  const messages = (source.messages as StampedMessage[]).filter((m) => m.traceId === id);
  return {
    id,
    get spans() {
      source.reporter.noteTrace();
      return sortSpans(source.spans.filter((span) => spanTraceId(span) === id));
    },
    toolCalls(name?: string) {
      return collectToolCalls({
        source,
        messages,
        spans: source.spans.filter((span) => spanTraceId(span) === id),
        name,
      });
    },
  };
}

/** One view per trace id the messages carry, in first-seen order. */
export function runTraces(source: StateViewSource): TraceView[] {
  source.reporter.noteTrace();
  return messageTraceIds(source.messages).map((id) => traceView({ source, id }));
}

/** One view per turn, from the turn stamps on the messages. */
export function runTurns(source: StateViewSource): TurnView[] {
  const turnOfMessage = turnOfMessageMap(source.messages);
  const grouped = new Map<number, ModelMessage[]>();
  for (const message of source.messages) {
    const index = turnOfMessage.get(message) ?? 0;
    const bucket = grouped.get(index) ?? [];
    bucket.push(message);
    grouped.set(index, bucket);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, messages]) => {
      const traceId = messageTraceIds(messages)[0];
      return {
        index,
        messages,
        get trace() {
          return traceId === undefined ? undefined : traceView({ source, id: traceId });
        },
        toolCalls(name?: string) {
          const turnTraceIds = new Set(messageTraceIds(messages));
          return collectToolCalls({
            source,
            messages,
            spans: source.spans.filter((span) => {
              const id = spanTraceId(span);
              return id !== undefined && turnTraceIds.has(id);
            }),
            name,
          });
        },
      };
    });
}
