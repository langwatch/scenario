/**
 * Resolves evaluator input mappings against the state of a finished run: the
 * conversation, the scenario definition and the spans of the trace.
 */
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { ModelMessage } from "ai";
import type { EvaluatorMapping, ScenarioFieldValue } from "../domain";

/** Everything an input can read from. */
export interface EvaluatorInputContext {
  messages: ModelMessage[];
  description: string;
  criteria: string[];
  fields: Record<string, ScenarioFieldValue>;
  spans: ReadableSpan[];
}

/**
 * How one mapping resolved. `skipped` and `failed` carry the reason the
 * evaluator reports instead of running; `needsTrace` says a trace source
 * found nothing yet, so the runner may fetch the remote trace and retry.
 */
export type ResolvedInput =
  | { kind: "value"; value: unknown }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string; needsTrace: true };

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

function stringify(value: unknown): string {
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

function firstUserMessage(messages: ModelMessage[]): string {
  const message = messages.find((m) => m.role === "user");
  return message ? messageText(message) : "";
}

function lastAgentMessage(messages: ModelMessage[]): string {
  const message = messages.findLast((m) => m.role === "assistant");
  return message ? messageText(message) : "";
}

function transcript(messages: ModelMessage[]): string {
  return messages.map((m) => `${m.role}: ${messageText(m)}`).join("\n");
}

interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
}

/**
 * Tool calls the agent returned in its messages: every `tool-call` part of an
 * assistant message, joined to the `tool-result` part with the same call id.
 */
function messageToolCalls(messages: ModelMessage[]): ToolCallRecord[] {
  const outputs = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-result") outputs.set(part.toolCallId, part.output);
    }
  }
  const calls: ToolCallRecord[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      calls.push({
        name: part.toolName,
        input: part.input,
        output: outputs.get(part.toolCallId),
      });
    }
  }
  return calls;
}

function attribute(span: ReadableSpan, keys: string[]): unknown {
  for (const key of keys) {
    const value = span.attributes[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Tool spans of the trace, in start order. */
function spanToolCalls(spans: ReadableSpan[]): ToolCallRecord[] {
  return spans
    .filter((span) => attribute(span, SPAN_TYPE_ATTRIBUTES) === TOOL_SPAN_TYPE)
    .map((span) => ({
      name: String(attribute(span, TOOL_NAME_ATTRIBUTES) ?? span.name),
      input: attribute(span, INPUT_ATTRIBUTES),
      output: attribute(span, OUTPUT_ATTRIBUTES),
    }));
}

/** The retrieved contexts of every rag span, concatenated. */
function spanContexts(spans: ReadableSpan[]): string[] {
  const contexts: string[] = [];
  for (const span of spans) {
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

function resolveToolCall({
  toolName,
  part,
  context,
}: {
  toolName: string;
  part: string;
  context: EvaluatorInputContext;
}): ResolvedInput {
  const calls = [
    ...messageToolCalls(context.messages),
    ...spanToolCalls(context.spans),
  ].filter((call) => call.name === toolName);
  const call = calls.at(-1);
  if (!call) {
    return {
      kind: "failed",
      reason: `no ${toolName} call in the trace`,
      needsTrace: true,
    };
  }
  return { kind: "value", value: part === "output" ? call.output : call.input };
}

/**
 * Resolves one mapping. A blank field skips the evaluator; a tool call or
 * contexts missing from the trace fail it.
 */
export function resolveInput({
  mapping,
  context,
}: {
  mapping: EvaluatorMapping;
  context: EvaluatorInputContext;
}): ResolvedInput {
  if (mapping.type === "value") return { kind: "value", value: mapping.value };

  const [head, ...rest] = mapping.path;
  switch (mapping.sourceId) {
    case "conversation":
      switch (head) {
        case "first_user_message":
          return { kind: "value", value: firstUserMessage(context.messages) };
        case "last_agent_message":
          return { kind: "value", value: lastAgentMessage(context.messages) };
        case "transcript":
          return { kind: "value", value: transcript(context.messages) };
        case "messages":
          return { kind: "value", value: context.messages };
      }
      break;
    case "scenario":
      switch (head) {
        case "situation":
          return { kind: "value", value: context.description };
        case "criteria":
          return { kind: "value", value: context.criteria.join("\n") };
        case "fields": {
          const name = rest[0] ?? "";
          const fieldValue = context.fields[name];
          if (fieldValue === undefined || fieldValue === null || fieldValue === "") {
            return { kind: "skipped", reason: `no ${name} on this scenario` };
          }
          return { kind: "value", value: fieldValue };
        }
      }
      break;
    case "trace":
      switch (head) {
        case "contexts": {
          const contexts = spanContexts(context.spans);
          if (contexts.length === 0) {
            return {
              kind: "failed",
              reason: "no retrieved contexts in the trace",
              needsTrace: true,
            };
          }
          return { kind: "value", value: contexts };
        }
        case "tool_calls":
          return resolveToolCall({
            toolName: rest[0] ?? "",
            part: rest[1] ?? "input",
            context,
          });
      }
      break;
  }
  return {
    kind: "skipped",
    reason: `unknown mapping ${mapping.sourceId}.${mapping.path.join(".")}`,
  };
}

/** Renders a resolved value for the `inputs` of an evaluation result. */
export function displayValue(value: unknown): string {
  return stringify(value);
}

/** True when the mapping reads the trace, so a remote fetch can help it. */
export function readsTrace(mapping: EvaluatorMapping): boolean {
  return mapping.type === "source" && mapping.sourceId === "trace";
}
