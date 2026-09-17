/**
 * Parser for Claude Code's `--output-format stream-json --verbose` stdout.
 *
 * Claude Code emits one JSON object per line. The objects we care about carry a
 * `message` field whose `content` is either a string or an array of content
 * blocks (`text`, `tool_use`, `tool_result`, ...). This module isolates the
 * line-splitting + block-rendering so the adapter stays thin and the rendering
 * rules are independently testable.
 *
 * Two renderings of the same transcript come out of {@link parseStreamJson}:
 *  - `text`: the assistant-visible text with tool calls and results rendered
 *    inline as readable lines.
 *  - `modelMessages`: AI SDK `ModelMessage`s with `tool-call` and
 *    `tool-result` parts, the shape the judge, the user simulator and the
 *    LangWatch run view read structurally (see {@link toModelMessages}).
 *
 * Both apply the same {@link TranscriptLimits}: a tool result can carry
 * hundreds of kilobytes (an exported trace, a log file), and the judge reads
 * the whole conversation on every step, so an uncapped result pushes a long
 * run past the judge's context window for a reason that has nothing to do
 * with the agent under test.
 *
 * Hardening over the original reference port:
 *  - `tool_result` blocks whose `content` is an array/object are rendered
 *    readably (text parts extracted, else JSON-stringified) — never the
 *    `[object Object]` string-coercion of the original.
 *  - Lines that parse to an object with an unrecognized top-level `type` are
 *    surfaced via `logger?.warn(...)` ("unknown event") rather than silently
 *    dropped or thrown — but at most ONCE per distinct type per call, so a
 *    token-level event stream (`stream_event` under `--include-partial-messages`)
 *    or any repeated novel type cannot flood the log.
 *  - The terminal `type: "result"` envelope is surfaced structurally
 *    ({@link ClaudeResultEnvelope}: `isError`/`subtype`/`errors`) so a caller can
 *    trust the CLI's own fielded status instead of inferring success from the
 *    exit code alone.
 */

import type { ModelMessage } from "ai";

/**
 * Minimal structural logger. Mirrors {@link Logger} in the adapter module; kept
 * as a local structural type so the parser has no cross-file import for what is
 * just `{ log, warn }`.
 */
interface StreamLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * A single content block inside a stream-json `message`. The Claude Code wire
 * format is open-ended, so unknown keys are tolerated via the index signature.
 */
export interface ClaudeStreamContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

/**
 * The inner `message` of a stream-json line: a role plus content that is either
 * a plain string or an array of {@link ClaudeStreamContentBlock}.
 */
export interface ClaudeStreamInnerMessage {
  role?: string;
  content?: string | ClaudeStreamContentBlock[];
  [key: string]: unknown;
}

/**
 * One parsed stream-json line. `type` is the event discriminator Claude Code
 * stamps on every line (e.g. `assistant`, `user`, `system`, `result`); `message`
 * is present on the conversational events we render.
 */
export interface ClaudeStreamMessage {
  type?: string;
  session_id?: string;
  message?: ClaudeStreamInnerMessage;
  [key: string]: unknown;
}

/**
 * The structured status the CLI fields on its terminal `type: "result"` line
 * (verified against Claude Code 2.1.205). `isError` is the CLI's own success
 * verdict — trust it over the process exit code (a stale `--resume`, for one,
 * can report `is_error: true`). `subtype` categorises the outcome
 * (`error_during_execution`, `success`, …) and `errors` carries the fielded
 * failure sentences (e.g. `"No conversation found with session ID: <id>"`).
 * Every field is optional: absent when no `result` line was emitted (older CLIs,
 * a crash before the envelope) or when that field was not present.
 */
export interface ClaudeResultEnvelope {
  isError?: boolean;
  subtype?: string;
  errors?: string[];
}

/**
 * How much of a tool call and of a tool result may reach the conversation.
 *
 * A result is the evidence the agent gathered, and what a judge reads of it is
 * short: command names, URLs and ids, which stand at the start of the output.
 * A call carries what the agent wrote (a file, a report, a test), which is the
 * work under judgement, so it keeps far more room, and there are few such
 * calls in a run.
 */
export interface TranscriptLimits {
  maxToolResultChars: number;
  maxToolInputChars: number;
}

export const DEFAULT_TRANSCRIPT_LIMITS: TranscriptLimits = {
  maxToolResultChars: 8000,
  maxToolInputChars: 30000,
};

/**
 * Top-level event `type`s we knowingly render or skip without warning. The
 * "unknown event" warning exists to flag wire-format drift, so every type the
 * CLI routinely emits must be listed — otherwise the warning fires on a healthy
 * run and stops meaning anything. `rate_limit_event` is emitted by Claude Code
 * 2.1.205 on ordinary runs (observed alongside `system`/`assistant`/`result`).
 * `stream_event` is the token-level delta the CLI emits under
 * `--include-partial-messages` (reachable via the adapter's `extraArgs`); a
 * single one-word reply produced 26 of them, so it must be known — the per-call
 * dedupe below is the durable guard, this allowlist entry avoids the noise
 * entirely for a type we understand.
 */
const KNOWN_EVENT_TYPES = new Set([
  "assistant",
  "user",
  "system",
  "result",
  "rate_limit_event",
  "stream_event",
]);

/**
 * The blocks the converters read. Anything else is a block Claude Code can
 * write that the conversation has no part for, most often an `image` or a
 * `document` a tool returned.
 */
const KNOWN_BLOCK_TYPES = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "tool_result",
]);

/** `JSON.stringify` that never throws (circular refs, custom toString, etc. → fallback string). */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable value]";
    }
  }
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `${text.slice(0, limit)}\n… [${dropped} more characters]`;
}

/**
 * The call cap over every string inside a tool input, structure kept. Nested
 * objects and arrays are walked, not only the top level: a payload such as
 * `{ body: { html } }` carries the same unbounded text a top-level field would.
 */
function truncateToolInput(input: unknown, limit: number): unknown {
  if (typeof input === "string") return truncateText(input, limit);
  if (Array.isArray(input)) return input.map((item) => truncateToolInput(item, limit));
  if (input === null || typeof input !== "object") return input;
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).map(([key, value]) => [
      key,
      truncateToolInput(value, limit),
    ]),
  );
}

/**
 * Render a `tool_result` block's `content` to a readable string.
 *
 * `content` may be a string, an array of `{ type: "text", text }` (and other)
 * blocks, or an arbitrary object. We extract text parts when present, else fall
 * back to a guarded `JSON.stringify`. Never returns `[object Object]`.
 */
function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const rendered = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return safeStringify(part);
      })
      .filter(Boolean);
    return rendered.join("\n");
  }

  return safeStringify(content);
}

/**
 * What a block of a type the conversation has no part for leaves behind. The
 * judge reads the transcript, so a block that silently disappeared would read
 * as a turn the agent never took; a line naming the type keeps the turn whole
 * and says what is not shown.
 */
function unsupportedBlockText(block: ClaudeStreamContentBlock): string {
  return `[${String(block.type ?? "unknown")} block, not shown in the transcript]`;
}

/**
 * Render a single content block to text.
 *  - `text`        → the text
 *  - `tool_use`    → `Tool Called: name({...input})`, input capped
 *  - `tool_result` → `Tool Result: <readable content>`, capped
 *  - `thinking`    → nothing; it is not part of the conversation
 *  - anything else → a line naming the block type
 */
function renderBlock(block: ClaudeStreamContentBlock, limits: TranscriptLimits): string {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "tool_use":
      return `Tool Called: ${block.name ?? "unknown"}(${truncateText(
        safeStringify(block.input),
        limits.maxToolInputChars,
      )})`;
    case "tool_result":
      return `Tool Result: ${truncateText(
        renderToolResultContent(block.content),
        limits.maxToolResultChars,
      )}`;
    case "thinking":
    case "redacted_thinking":
      return "";
    default:
      return unsupportedBlockText(block);
  }
}

/** Concatenated assistant-visible text for one inner message. */
function renderMessage(message: ClaudeStreamInnerMessage, limits: TranscriptLimits): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => renderBlock(block, limits))
    .filter(Boolean)
    .join("\n");
}

/** One assistant turn: the text it wrote, then the tool calls it made. */
function assistantMessageFromBlocks(
  content: ClaudeStreamContentBlock[],
  toolNamesByCallId: Map<string, string>,
  limits: TranscriptLimits,
): ModelMessage | null {
  const texts: string[] = [];
  const toolCalls: Array<{
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    input: unknown;
  }> = [];

  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "tool_use") {
      const id = String(block["id"] ?? "");
      const name = block.name ?? "tool";
      toolNamesByCallId.set(id, name);
      toolCalls.push({
        type: "tool-call",
        toolCallId: id,
        toolName: name,
        input: truncateToolInput(block.input ?? {}, limits.maxToolInputChars),
      });
    } else if (!KNOWN_BLOCK_TYPES.has(block.type ?? "")) {
      texts.push(unsupportedBlockText(block));
    }
    // Thinking blocks are dropped: they are not part of the conversation.
  }

  if (texts.length === 0 && toolCalls.length === 0) return null;
  // The text part stays even when empty, so a turn that only called tools
  // still carries its calls next to a string content.
  return {
    role: "assistant",
    content: [{ type: "text", text: texts.join("\n") }, ...toolCalls],
  };
}

/**
 * One user turn: the tool results it answers with become a `tool` message, and
 * whatever text it carries becomes a `user` message after it.
 */
function userMessagesFromBlocks(
  content: ClaudeStreamContentBlock[],
  toolNamesByCallId: Map<string, string>,
  limits: TranscriptLimits,
): ModelMessage[] {
  const messages: ModelMessage[] = [];

  const toolResults = content
    .filter((block) => block.type === "tool_result")
    .map((block) => {
      const callId = String(block["tool_use_id"] ?? "");
      const value = truncateText(
        renderToolResultContent(block.content),
        limits.maxToolResultChars,
      );
      return {
        type: "tool-result" as const,
        toolCallId: callId,
        toolName: toolNamesByCallId.get(callId) ?? "tool",
        output: block["is_error"]
          ? { type: "error-text" as const, value }
          : { type: "text" as const, value },
      };
    });
  if (toolResults.length > 0) {
    messages.push({ role: "tool", content: toolResults });
  }

  const texts = content
    .filter(
      (block) =>
        (block.type === "text" && typeof block.text === "string") ||
        !KNOWN_BLOCK_TYPES.has(block.type ?? ""),
    )
    .map((block) =>
      block.type === "text" ? (block.text as string) : unsupportedBlockText(block),
    );
  if (texts.length > 0) {
    messages.push({ role: "user", content: texts.join("\n") });
  }

  return messages;
}

/**
 * Converts the inner messages of a stream-json transcript into AI SDK model
 * messages, the format `@langwatch/scenario` works with.
 *
 * Claude Code writes Anthropic-format messages: an assistant turn is an array
 * of `thinking`, `text` and `tool_use` blocks, and each tool result comes back
 * as a `user` message holding `tool_result` blocks. Each assistant turn
 * becomes one text part (the text blocks joined, an empty string when the turn
 * only called tools) followed by one `tool-call` part per `tool_use` block.
 * Each `tool_result` block becomes a `tool-result` part of a `tool` message,
 * with the tool name looked up from the call it answers. Thinking blocks are
 * dropped. A block of any other type leaves a line naming it.
 */
export function toModelMessages(
  rawMessages: ClaudeStreamInnerMessage[],
  limits: TranscriptLimits = DEFAULT_TRANSCRIPT_LIMITS,
): ModelMessage[] {
  const toolNamesByCallId = new Map<string, string>();
  const messages: ModelMessage[] = [];

  for (const raw of rawMessages) {
    const { role, content } = raw;
    if (role !== "assistant" && role !== "user") continue;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "assistant") {
      const message = assistantMessageFromBlocks(content, toolNamesByCallId, limits);
      if (message) messages.push(message);
      continue;
    }
    messages.push(...userMessagesFromBlocks(content, toolNamesByCallId, limits));
  }

  return messages;
}

/**
 * Parse Claude Code stream-json stdout into the concatenated assistant text,
 * the structured model messages, and the list of parsed lines.
 *
 * @param stdout - Raw stdout (possibly many newline-delimited JSON objects).
 * @param logger - Optional structural logger; receives an "unknown event"
 *   `warn` for any line whose parsed `type` is unrecognized — at most ONCE per
 *   distinct type per call, so a repeated novel type cannot flood the log.
 *   Never throws on a malformed line — non-JSON lines are skipped.
 * @param limits - How much of a tool call and a tool result reaches either
 *   rendering. Defaults to {@link DEFAULT_TRANSCRIPT_LIMITS}.
 * @returns `{ text, modelMessages, messages, sessionId, result }`: `text` is
 *   the joined assistant-visible text, `modelMessages` the same transcript as
 *   AI SDK messages ({@link toModelMessages}), `messages` is every
 *   successfully-parsed line, `sessionId` is the top-level `session_id` Claude
 *   Code stamps on its `system`/init line (and may restamp on later events;
 *   last-wins, left `undefined` when no line carries one), and `result` is the
 *   terminal {@link ClaudeResultEnvelope} read off the `type: "result"` line
 *   (an empty object when none was emitted). The adapter threads `sessionId`
 *   to continue a session across turns and inspects `result` to tell a real
 *   failure, including a stale `--resume`, from a healthy run (see the
 *   adapter's `call`).
 */
export function parseStreamJson(
  stdout: string,
  logger?: StreamLogger,
  limits: TranscriptLimits = DEFAULT_TRANSCRIPT_LIMITS,
): {
  text: string;
  modelMessages: ModelMessage[];
  messages: ClaudeStreamMessage[];
  sessionId?: string;
  result: ClaudeResultEnvelope;
} {
  const messages: ClaudeStreamMessage[] = [];
  let sessionId: string | undefined;
  let result: ClaudeResultEnvelope = {};
  // Warn at most once per distinct unrecognized type in this call. Reactive
  // allowlisting is whack-a-mole; deduping is the durable fix against a
  // per-token event stream turning one novelty into hundreds of warnings.
  const warnedUnknownTypes = new Set<string>();

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON line (e.g. a stray log line): skip silently.
      continue;
    }

    if (!parsed || typeof parsed !== "object") continue;

    const message = parsed as ClaudeStreamMessage;
    messages.push(message);

    // Capture the conversation's session id. It rides as a top-level
    // `session_id` (distinct from any per-event `uuid`) on the `system`/init
    // line and may reappear on later events; take the last one seen. Truthy
    // check so an empty string never overwrites a real id.
    if (message.session_id) {
      sessionId = message.session_id;
    }

    // The terminal `result` line fields the run's status structurally. Read it
    // off untyped wire keys (guarded), last-wins. The adapter trusts `isError`
    // over the exit code and keys stale-session detection off `subtype`/`errors`.
    if (message.type === "result") {
      const rawIsError = message["is_error"];
      const rawSubtype = message["subtype"];
      const rawErrors = message["errors"];
      result = {
        isError: typeof rawIsError === "boolean" ? rawIsError : undefined,
        subtype: typeof rawSubtype === "string" ? rawSubtype : undefined,
        errors: Array.isArray(rawErrors)
          ? rawErrors.filter((e): e is string => typeof e === "string")
          : undefined,
      };
    }

    if (
      typeof message.type === "string" &&
      !KNOWN_EVENT_TYPES.has(message.type) &&
      !warnedUnknownTypes.has(message.type)
    ) {
      warnedUnknownTypes.add(message.type);
      logger?.warn(`Claude Code stream-json: unknown event type "${message.type}"`);
    }
  }

  const innerMessages = messages
    .map((m) => m.message)
    .filter((m): m is ClaudeStreamInnerMessage => Boolean(m));

  const text = innerMessages
    .map((m) => renderMessage(m, limits))
    .filter(Boolean)
    .join("\n\n");

  return {
    text,
    modelMessages: toModelMessages(innerMessages, limits),
    messages,
    sessionId,
    result,
  };
}
