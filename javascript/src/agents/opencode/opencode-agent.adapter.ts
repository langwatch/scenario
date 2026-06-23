/**
 * OpenCode Agent Adapter for Scenario Testing
 *
 * Adapts the OpenCode coding agent (via `@opencode-ai/sdk`) to the Scenario
 * {@link AgentAdapter} interface. Each `call` extracts the new user turn,
 * resolves (or reuses) a server-side OpenCode session for the conversation
 * thread, drives a single `session.prompt(...)` completion, and returns the
 * assistant-visible text as a `string`.
 *
 * Unlike the Claude Code sibling adapter — which spawns `claude -p` per turn and
 * REPLAYS the conversation as a flat prompt — OpenCode keeps the full transcript
 * SERVER-SIDE keyed by a session id. The SDK's `session.prompt(...)` resolves
 * only after the assistant finishes (a completion primitive; no SSE needed), and
 * the session already holds the prior turns. Therefore:
 *  - We send ONLY the NEW user text ({@link extractNewUserText} over
 *    `input.newMessages`), never a full-history flatten. Re-sending the whole
 *    transcript every turn would duplicate context the server already has.
 *  - We branch on session-exists ONLY to decide create-vs-reuse — NEVER to shape
 *    the payload. The payload is always just the latest user delta.
 *
 * Session continuation (multiturn): the adapter instance is reused across a
 * scenario's turns, so it keeps a per-thread map (`threadId` → `session.id`):
 *  - First turn for a `threadId`: `session.create(...)`, store the returned id.
 *  - Subsequent turns: reuse the stored id as `path.id` on `session.prompt(...)`.
 *  - If a continuation `prompt(...)` fails at the transport layer, the stored id
 *    is EVICTED so the next turn for that thread recreates the session (the
 *    stored session may no longer resolve) — mirroring the Claude Code sibling's
 *    `--resume` eviction.
 *
 * Two-layer error handling (the SDK uses responseStyle "fields" with
 * `throwOnError` defaulting to `false`, so the calls resolve to `{ data, error }`
 * and do NOT throw on HTTP errors):
 *  1. Transport layer — `result.error` truthy ⇒ the request itself failed.
 *  2. Semantic layer — `result.data.info.error` truthy ⇒ HTTP 200 but the
 *     assistant message carries a provider/runtime error (and typically empty
 *     text). We surface it by NAME (`ProviderAuthError | UnknownError |
 *     MessageOutputLengthError | MessageAbortedError | APIError`).
 *
 * Empty-text fallback (R3): a successful completion with parts but no visible
 * text (e.g. a tool-only turn) returns a NON-EMPTY readable fallback rather than
 * "" — an empty string would silently look like a no-op assistant turn. Only a
 * completion with NO parts at all is treated as a genuine empty response and
 * rejected.
 *
 * Hardening (mirrors the Claude Code sibling):
 *  a. Structured non-text parts are rendered readably, never `[object Object]`.
 *  b. An optional `timeout` cancels the in-flight prompt via `AbortSignal`.
 *  c. All diagnostics route through an injectable {@link Logger}; absent one, a
 *     no-op logger is used. No `console.*` and no `chalk` anywhere.
 *  d. The OpencodeClient is an injection seam (`config.client`): provide your own
 *     for tests (no real server, no spawn), or omit it to let the adapter lazily
 *     spawn and own an OpenCode server (closed by {@link OpenCodeAgentAdapter.close}).
 */

import { createOpencode } from "@opencode-ai/sdk";
import type { OpencodeClient, Part } from "@opencode-ai/sdk";
import type { ModelMessage } from "ai";

import { AgentAdapter, AgentRole } from "../../domain/agents/index.js";
import type { AgentInput, AgentReturnTypes } from "../../domain/agents/index.js";

/**
 * Minimal structural logger the adapter routes ALL diagnostics through. Provide
 * your own (e.g. wrapping a real logger) or omit it for silent operation.
 */
export interface Logger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** No-op logger used when none is injected — keeps the adapter silent and console-free. */
const noopLogger: Logger = {
  log: () => undefined,
  warn: () => undefined,
};

/**
 * The auto-spawned OpenCode server handle the adapter owns when no `client` is
 * injected. We memoize the resolving PROMISE (not the resolved value) so two
 * concurrent `call`s share a single server spawn instead of racing two.
 */
interface OwnedServer {
  client: OpencodeClient;
  server: { close(): void };
}

/**
 * Configuration for {@link OpenCodeAgentAdapter}.
 */
export interface OpenCodeAgentAdapterConfig {
  /**
   * Provider/model the OpenCode agent runs. REQUIRED — this is a product choice
   * for reproducible evals (the SDK itself treats `model` as optional, but a
   * scenario should pin a deterministic model), e.g.
   * `{ providerID: "openai", modelID: "gpt-4o-mini" }`.
   */
  model: { providerID: string; modelID: string };

  /**
   * Directory the OpenCode agent operates on. Forwarded as `query.directory` on
   * both `session.create` and `session.prompt` (the SDK has no top-level `cwd`;
   * working directory is a per-request query parameter). Files the agent reads
   * or writes resolve relative to this.
   */
  workingDirectory?: string;

  /**
   * Per-call timeout in milliseconds. When set, the in-flight `session.prompt`
   * is cancelled via `AbortSignal.timeout(timeout)` and the call rejects.
   * Best-effort: if the underlying server ignores the abort, the call still
   * settles when the prompt resolves. Default: none (unbounded).
   */
  timeout?: number;

  /**
   * Optional logger for all diagnostics. Defaults to a no-op logger (silent).
   */
  logger?: Logger;

  /**
   * Injection seam for the OpenCode SDK client. When provided, the adapter uses
   * it directly and does NOT own/spawn a server ({@link OpenCodeAgentAdapter.close}
   * is then a no-op). When omitted, the adapter lazily `createOpencode()`s a
   * server on first use and owns its lifecycle.
   */
  client?: OpencodeClient;
}

/**
 * Adapter that runs OpenCode as a Scenario agent.
 *
 * @example
 * ```typescript
 * const adapter = new OpenCodeAgentAdapter({
 *   model: { providerID: "openai", modelID: "gpt-4o-mini" },
 *   workingDirectory: "/tmp/project",
 * });
 * await scenario.run({
 *   agents: [adapter, scenario.userSimulatorAgent(), scenario.judgeAgent({ criteria: [...] })],
 *   script: [scenario.user("..."), scenario.agent(), scenario.judge()],
 * });
 * await adapter.close();
 * ```
 */
export class OpenCodeAgentAdapter extends AgentAdapter {
  role: AgentRole = AgentRole.AGENT;
  name = "OpenCodeAgent";

  /**
   * Per-thread OpenCode session ids (`threadId` → `session.id`). Populated after
   * a thread's first turn and consulted on every subsequent turn to reuse the
   * server-side session. The adapter instance is reused across a scenario's
   * turns, so this persists for the conversation's lifetime. Evicted on a
   * continuation prompt failure so the next turn rebuilds the session.
   */
  private sessions = new Map<string, string>();

  /**
   * Memoized auto-spawned server promise — set only when no `client` is
   * injected and the adapter spawns its own OpenCode server. Memoizing the
   * PROMISE (not the resolved handle) makes concurrent first `call`s share one
   * spawn instead of racing.
   */
  private serverPromise: Promise<OwnedServer> | null = null;

  constructor(private config: OpenCodeAgentAdapterConfig) {
    super();
  }

  /** The effective logger (injected or no-op). */
  private get logger(): Logger {
    return this.config.logger ?? noopLogger;
  }

  /**
   * Resolve the OpencodeClient to drive. Returns the injected client if present;
   * otherwise lazily spawns (and memoizes) an OpenCode server and returns its
   * client. The server spawn shells out to the `opencode` binary, so live use
   * (no injected client) requires `opencode` on PATH.
   */
  private async ensureClient(): Promise<OpencodeClient> {
    if (this.config.client) {
      return this.config.client;
    }
    // Memoize the PROMISE, not the resolved value: two concurrent calls must
    // share one createOpencode() spawn rather than each spawning a server.
    this.serverPromise ??= createOpencode();
    const { client } = await this.serverPromise;
    return client;
  }

  /** `query.directory` payload when a working directory is configured, else nothing. */
  private directoryQuery(): { directory: string } | undefined {
    return this.config.workingDirectory
      ? { directory: this.config.workingDirectory }
      : undefined;
  }

  /**
   * Resolve (creating if needed) the server-side session id for a thread. The
   * `create` happens AT MOST once per `threadId` (subsequent turns reuse the
   * stored id), satisfying the one-session-per-thread contract.
   *
   * @returns the session id and whether it was reused (a continuation turn).
   */
  private async resolveSessionId(
    threadId: string,
    client: OpencodeClient,
  ): Promise<{ sessionId: string; isContinuation: boolean }> {
    const existing = this.sessions.get(threadId);
    if (existing) {
      return { sessionId: existing, isContinuation: true };
    }

    const created = await client.session.create({
      body: { title: `scenario:${threadId}` },
      ...(this.directoryQuery() ? { query: this.directoryQuery() } : {}),
    });
    if (created.error || !created.data?.id) {
      throw new Error(
        `OpenCode session.create failed for thread "${threadId}": ${describeTransportError(
          created.error,
        )}`,
      );
    }

    const sessionId = created.data.id;
    this.sessions.set(threadId, sessionId);
    return { sessionId, isContinuation: false };
  }

  /**
   * Process the conversation and return OpenCode's assistant text.
   *
   * @param input - Scenario agent input (conversation history etc.).
   * @returns The concatenated assistant-visible text as a string.
   */
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    // OpenCode is prompt-driven and holds prior turns server-side, so we send
    // ONLY the new user delta — never a full-history flatten. Compute it FIRST
    // so the empty-input guard rejects before any RPC (no wasted session
    // create/prompt for an agent-first wiring bug).
    const promptText = extractNewUserText(input.newMessages);
    if (!promptText) {
      throw new Error(
        "OpenCodeAgentAdapter received no user message to send. OpenCode is " +
          "prompt-driven and cannot open a conversation on its own; ensure a " +
          "user turn precedes the agent (e.g. a scenario.user(...) step before " +
          "scenario.agent()).",
      );
    }

    const client = await this.ensureClient();
    const { sessionId, isContinuation } = await this.resolveSessionId(
      input.threadId,
      client,
    );

    this.logger.log(
      `OpenCode prompting session ${sessionId} (thread ${input.threadId})`,
    );

    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: this.config.model,
        parts: [{ type: "text", text: promptText }],
      },
      ...(this.directoryQuery() ? { query: this.directoryQuery() } : {}),
      // Best-effort cancellation: AbortSignal.timeout is a valid prompt option
      // (it survives on RequestOptions). If the server ignores it, the call
      // still settles when the prompt resolves.
      ...(this.config.timeout
        ? { signal: AbortSignal.timeout(this.config.timeout) }
        : {}),
    });

    // Layer 1 — transport error. Evict a stale continuation session so the next
    // turn recreates it, then surface a friendly error.
    if (result.error) {
      if (isContinuation) {
        this.sessions.delete(input.threadId);
      }
      throw new Error(
        `OpenCode prompt failed: ${describeTransportError(result.error)}`,
      );
    }

    // Layer 2 — semantic error: HTTP 200 but the assistant message carries a
    // provider/runtime error (and usually empty text). Name the variant.
    const infoError = result.data?.info?.error;
    if (infoError) {
      throw new Error(`OpenCode returned an error: ${describeInfoError(infoError)}`);
    }

    const parts = result.data?.parts;
    const text = partsToText(parts);
    if (text) {
      return text;
    }

    // R3 — a completion with parts but no visible text (e.g. a tool-only turn):
    // return a non-empty readable fallback rather than a silent "".
    if (parts && parts.length > 0) {
      return parts.map(renderNonTextPart).filter(Boolean).join("\n");
    }

    // No parts at all — a genuinely empty response.
    throw new Error("OpenCode returned an empty response (no parts).");
  }

  /**
   * Tear down any server this adapter spawned. When a `client` was injected the
   * adapter owns no server and this is a no-op. Call this in a scenario's
   * teardown (e.g. `afterAll`) to release the auto-spawned OpenCode server.
   */
  async close(): Promise<void> {
    if (!this.serverPromise) {
      return;
    }
    const { server } = await this.serverPromise;
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Module-scope helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text of the NEW user turn(s) to send to OpenCode.
 *
 * Renders USER-role messages ONLY (via {@link renderContent}) — assistant and
 * tool turns are deliberately NOT flattened, because OpenCode already holds them
 * server-side; re-sending them would duplicate context. Empty renders are
 * dropped and the rest joined by a blank line. Returns "" when there is no user
 * content (the agent-first / empty-delta case the caller guards on).
 */
export function extractNewUserText(newMessages: ModelMessage[]): string {
  return newMessages
    .filter((m) => m.role === "user")
    .map((m) => renderContent(m.content))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

/**
 * Render a single message's content to a string.
 *
 * A string is returned as-is; an array of content blocks is rendered block by
 * block ({@link renderContentBlock}) and joined. A message whose content is only
 * structured (e.g. tool) blocks therefore renders to those blocks — never an
 * empty string from a non-empty input.
 */
export function renderContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(renderContentBlock).filter(Boolean).join("\n");
}

/**
 * Render a single `ai`-SDK content block to a readable string. Structured blocks
 * are made readable rather than dropped, so a tool-call/tool-result is preserved
 * in the prompt instead of collapsing to a bare label. NOTE the `ai`-SDK block
 * discriminators are HYPHENATED (`tool-call`, `tool-result`).
 */
function renderContentBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";

  const b = block as Record<string, unknown>;
  switch (b["type"]) {
    case "text":
    case "reasoning":
      return typeof b["text"] === "string" ? b["text"] : "";
    case "tool-call":
      return `[tool-call: ${String(b["toolName"] ?? "unknown")}(${safeStringify(
        b["input"],
      )})]`;
    case "tool-result":
      return `[tool-result: ${String(b["toolName"] ?? "unknown")} -> ${safeStringify(
        b["output"] ?? b["result"],
      )}]`;
    case "file":
      return `[file: ${String(b["mediaType"] ?? "application/octet-stream")}]`;
    default:
      // Unknown block: still surface it readably rather than dropping it.
      return safeStringify(block);
  }
}

/**
 * Concatenate the visible assistant text from an OpenCode response's parts.
 *
 * Keeps ONLY `type === "text"` parts that are not `ignored`, joins their `.text`
 * with newlines, and SKIPS every other part type (tool, reasoning, step-start,
 * step-finish, file, …) WITHOUT throwing — a real reply interleaves those and
 * only the text parts are the visible assistant message. Defensive indexing (via
 * a `Record<string, unknown>` cast) avoids fighting the large `Part` union for
 * the three fields we read.
 */
export function partsToText(parts: Part[] | undefined): string {
  return (parts ?? [])
    .filter((part) => {
      const p = part as unknown as Record<string, unknown>;
      return p?.["type"] === "text" && p?.["ignored"] !== true;
    })
    .map((part) => {
      const p = part as unknown as Record<string, unknown>;
      return typeof p["text"] === "string" ? p["text"] : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Readable label for a non-text OpenCode part, used ONLY for the R3 empty-text
 * fallback (a completion with parts but no visible text). Surfaces the part type
 * and, when present, a name/tool/path hint — never returns "" for a real part.
 */
export function renderNonTextPart(part: unknown): string {
  if (!part || typeof part !== "object") return safeStringify(part);
  const p = part as Record<string, unknown>;
  const type = typeof p["type"] === "string" ? (p["type"] as string) : "part";
  const hint = p["tool"] ?? p["name"] ?? p["path"] ?? p["filename"];
  return typeof hint === "string" && hint.length > 0
    ? `[${type}: ${hint}]`
    : `[${type}]`;
}

/** Describe a transport-layer error object defensively (shape varies across endpoints). */
function describeTransportError(error: unknown): string {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as Record<string, unknown>;
    const message =
      typeof e["message"] === "string" ? (e["message"] as string) : undefined;
    const status = e["status"] ?? e["statusCode"] ?? e["code"];
    if (message && status !== undefined) return `${message} (status ${String(status)})`;
    if (message) return message;
  }
  return safeStringify(error);
}

/**
 * Describe a semantic `info.error` variant by NAME. The union is
 * `ProviderAuthError | UnknownError | MessageOutputLengthError |
 * MessageAbortedError | APIError`, each `{ name, data }` — but we read `.name`,
 * `.message`, and `.data.message` defensively since shapes vary.
 */
function describeInfoError(error: unknown): string {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as Record<string, unknown>;
    const name = typeof e["name"] === "string" ? (e["name"] as string) : undefined;
    const data = (e["data"] as Record<string, unknown> | undefined) ?? undefined;
    const message =
      (typeof e["message"] === "string" ? (e["message"] as string) : undefined) ??
      (data && typeof data["message"] === "string"
        ? (data["message"] as string)
        : undefined);
    if (name && message) return `${name}: ${message}`;
    if (name) return name;
    if (message) return message;
  }
  return safeStringify(error);
}

/**
 * Circular-safe `JSON.stringify`. A `WeakSet` seen-guard replaces any value
 * already on the current path with `"[Circular]"` so structured parts/blocks
 * never throw on a self-referential object. Non-serializable inputs fall back to
 * `String(value)`.
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val && typeof val === "object") {
        if (seen.has(val as object)) return "[Circular]";
        seen.add(val as object);
      }
      return val as unknown;
    });
  } catch {
    return String(value);
  }
}
