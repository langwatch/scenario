/**
 * Parser for Claude Code's `--output-format stream-json --verbose` stdout.
 *
 * Claude Code emits one JSON object per line. The objects we care about carry a
 * `message` field whose `content` is either a string or an array of content
 * blocks (`text`, `tool_use`, `tool_result`, ...). This module isolates the
 * line-splitting + block-rendering so the adapter stays thin and the rendering
 * rules are independently testable.
 *
 * Hardening over the original reference port:
 *  - `tool_result` blocks whose `content` is an array/object are rendered
 *    readably (text parts extracted, else JSON-stringified) — never the
 *    `[object Object]` string-coercion of the original.
 *  - Lines that parse to an object with an unrecognized top-level `type` are
 *    surfaced via `logger?.warn(...)` ("unknown event") rather than silently
 *    dropped or thrown.
 */

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
  message?: ClaudeStreamInnerMessage;
  [key: string]: unknown;
}

/** Top-level event `type`s we knowingly render or skip without warning. */
const KNOWN_EVENT_TYPES = new Set([
  "assistant",
  "user",
  "system",
  "result",
]);

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

/**
 * Render a single content block to text.
 *  - `text`        → the text
 *  - `tool_use`    → `Tool Called: name({...input})`
 *  - `tool_result` → `Tool Result: <readable content>`
 *  - anything else → empty string (dropped from the concatenated text)
 */
function renderBlock(block: ClaudeStreamContentBlock): string {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "tool_use":
      return `Tool Called: ${block.name ?? "unknown"}(${safeStringify(
        block.input,
      )})`;
    case "tool_result":
      return `Tool Result: ${renderToolResultContent(block.content)}`;
    default:
      return "";
  }
}

/** Concatenated assistant-visible text for one inner message. */
function renderMessage(message: ClaudeStreamInnerMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(renderBlock).filter(Boolean).join("\n");
}

/**
 * Parse Claude Code stream-json stdout into the concatenated assistant text and
 * the list of parsed messages.
 *
 * @param stdout - Raw stdout (possibly many newline-delimited JSON objects).
 * @param logger - Optional structural logger; receives an "unknown event"
 *   `warn` for any line whose parsed `type` is unrecognized. Never throws on a
 *   malformed line — non-JSON lines are skipped.
 * @returns `{ text, messages, sessionId }` — `text` is the joined
 *   assistant-visible text, `messages` is every successfully-parsed line, and
 *   `sessionId` is the top-level `session_id` Claude Code stamps on its
 *   `system`/init line (and may restamp on later events). Last-wins across
 *   lines so a refreshed id on a `--resume` turn is the one returned; left
 *   `undefined` when no line carries a `session_id`. The adapter threads this
 *   to continue a session across turns (see the adapter's `call`).
 */
export function parseStreamJson(
  stdout: string,
  logger?: StreamLogger,
): { text: string; messages: ClaudeStreamMessage[]; sessionId?: string } {
  const messages: ClaudeStreamMessage[] = [];
  let sessionId: string | undefined;

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
    // line and may reappear on later events; take the last one seen.
    if (typeof message["session_id"] === "string") {
      sessionId = message["session_id"];
    }

    if (
      typeof message.type === "string" &&
      !KNOWN_EVENT_TYPES.has(message.type)
    ) {
      logger?.warn(`Claude Code stream-json: unknown event type "${message.type}"`);
    }
  }

  const text = messages
    .filter((m): m is ClaudeStreamMessage & { message: ClaudeStreamInnerMessage } =>
      Boolean(m.message),
    )
    .map((m) => renderMessage(m.message))
    .filter(Boolean)
    .join("\n\n");

  return { text, messages, sessionId };
}
