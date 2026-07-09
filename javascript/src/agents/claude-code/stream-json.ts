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
 *    dropped or thrown — but at most ONCE per distinct type per call, so a
 *    token-level event stream (`stream_event` under `--include-partial-messages`)
 *    or any repeated novel type cannot flood the log.
 *  - The terminal `type: "result"` envelope is surfaced structurally
 *    ({@link ClaudeResultEnvelope}: `isError`/`subtype`/`errors`) so a caller can
 *    trust the CLI's own fielded status instead of inferring success from the
 *    exit code alone.
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
 *   `warn` for any line whose parsed `type` is unrecognized — at most ONCE per
 *   distinct type per call, so a repeated novel type cannot flood the log.
 *   Never throws on a malformed line — non-JSON lines are skipped.
 * @returns `{ text, messages, sessionId, result }` — `text` is the joined
 *   assistant-visible text, `messages` is every successfully-parsed line,
 *   `sessionId` is the top-level `session_id` Claude Code stamps on its
 *   `system`/init line (and may restamp on later events; last-wins, left
 *   `undefined` when no line carries one), and `result` is the terminal
 *   {@link ClaudeResultEnvelope} read off the `type: "result"` line (an empty
 *   object when none was emitted). The adapter threads `sessionId` to continue a
 *   session across turns and inspects `result` to tell a real failure — including
 *   a stale `--resume` — from a healthy run (see the adapter's `call`).
 */
export function parseStreamJson(
  stdout: string,
  logger?: StreamLogger,
): {
  text: string;
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

  const text = messages
    .filter((m): m is ClaudeStreamMessage & { message: ClaudeStreamInnerMessage } =>
      Boolean(m.message),
    )
    .map((m) => renderMessage(m.message))
    .filter(Boolean)
    .join("\n\n");

  return { text, messages, sessionId, result };
}
