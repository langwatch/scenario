/**
 * OpenCode Agent Adapter for Scenario Testing
 *
 * Adapts the OpenCode coding agent (via `@opencode-ai/sdk`) to the Scenario
 * {@link AgentAdapter} interface. Each `call` extracts the new user turn,
 * resolves (or reuses) a server-side OpenCode session for the conversation
 * thread, drives a single `session.prompt(...)` completion, and returns the
 * assistant-visible text as a `string`.
 *
 * Unlike a replay-style coding adapter — e.g. the sibling Claude Code adapter
 * (`claude-code/`), which spawns `claude -p` per turn and REPLAYS the conversation
 * as a flat prompt — OpenCode keeps the full transcript SERVER-SIDE keyed by a session
 * id. The SDK's `session.prompt(...)` resolves
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
 *    stored session may no longer resolve) — the same eviction-on-failure stance
 *    the sibling Claude Code adapter (`claude-code/`) takes for its `--resume` id.
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
 * Hardening (a–c mirror the sibling Claude Code adapter (`claude-code/`); d–e are
 * specific to this adapter's SDK/server model):
 *  a. Structured non-text parts are rendered readably, never `[object Object]`.
 *  b. An optional `timeout` cancels the in-flight prompt via `AbortSignal`.
 *  c. All diagnostics route through an injectable {@link OpenCodeLogger}; absent
 *     one, a no-op logger is used. No `console.*` and no `chalk` anywhere.
 *  d. The OpencodeClient is an injection seam (`config.client`): provide your own
 *     for tests (no real server, no spawn), or omit it to let the adapter lazily
 *     spawn and own an OpenCode server (closed by {@link OpenCodeAgentAdapter.close}).
 *  e. `close()` is terminal and idempotent: a `call(...)` issued after `close()`
 *     rejects with a clear closed-adapter error — full contract on
 *     {@link OpenCodeAgentAdapter.close}.
 */

import { createOpencode } from "@opencode-ai/sdk";
import type { OpencodeClient, Part } from "@opencode-ai/sdk";
import type { ModelMessage } from "ai";

import { AgentAdapter, AgentRole } from "../../domain/agents";
import type { AgentInput, AgentReturnTypes } from "../../domain/agents";
import { stringifyValue } from "../utils";

/**
 * Minimal structural logger the adapter routes ALL diagnostics through. Provide
 * your own (e.g. wrapping a real logger) or omit it for silent operation. Named
 * `OpenCodeLogger` to avoid colliding with the `Logger` class in
 * `src/utils/logger.ts` when re-exported from the package barrel.
 */
export interface OpenCodeLogger {
  log: (...args: unknown[]) => void;
}

/** No-op logger used when none is injected — keeps the adapter silent and console-free. */
const noopLogger: OpenCodeLogger = {
  log: () => undefined,
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
 * The fields of an awaited `client.session.prompt(...)` the triage reads — under
 * the SDK's "fields" responseStyle the call resolves to `{ data, error }` and
 * never throws. Typed structurally (not via `Awaited<ReturnType<…>>`, whose
 * generic `ThrowOnError` default collapses to the throw-branch and drops `error`)
 * so {@link OpenCodeAgentAdapter.interpretPromptResult} reads exactly the surface
 * it uses: the transport `error`, the semantic `data.info.error`, and `data.parts`.
 */
type PromptResult = {
  error?: unknown;
  data?: { info?: { error?: unknown }; parts?: Part[] };
};

/**
 * Configuration for {@link OpenCodeAgentAdapter}.
 */
export interface OpenCodeAgentAdapterConfig {
  /**
   * Provider/model the OpenCode agent runs. REQUIRED — this is a product choice
   * for reproducible evals (the SDK itself treats `model` as optional, but a
   * scenario should pin a deterministic model), e.g.
   * `{ providerID: "openai", modelID: "gpt-5.4-mini" }`.
   */
  model: { providerID: string; modelID: string };

  /**
   * Directory the OpenCode agent operates on. Forwarded as `query.directory` on
   * both `session.create` and `session.prompt` (the SDK has no top-level `cwd`;
   * working directory is a per-request query parameter). Files the agent reads
   * or writes resolve relative to this.
   *
   * REQUIRED — mirrors the sibling Claude Code adapter's `workingDirectory`.
   * OpenCode is tool-bearing (it reads/writes files and runs shell), so the
   * caller MUST name the directory it operates in. Were this optional and left
   * unset, no `query.directory` would be sent and the agent would fall back to
   * the OpenCode server's inherited process cwd — whatever launched it — which
   * may hold secrets (e.g. a gitignored `.env`). Point it at a scratch or
   * project directory the agent is meant to touch, never one holding credentials.
   */
  workingDirectory: string;

  /**
   * Timeout in milliseconds for the `session.prompt` call. When set, the
   * in-flight prompt is cancelled via `AbortSignal.timeout(timeout)` and the
   * call rejects. Best-effort: if the underlying server ignores the abort, the
   * call still settles when the prompt resolves. Default: none (unbounded).
   *
   * Bounds the **prompt only** — not the one-time server spawn or
   * `session.create` that may precede it. Total `call()` wall-clock is
   * therefore `spawn + create + timeout`, not `timeout`.
   */
  timeout?: number;

  /**
   * Optional logger for all diagnostics. Defaults to a no-op logger (silent).
   */
  logger?: OpenCodeLogger;

  /**
   * Injection seam for the OpenCode SDK client. When provided, the adapter uses
   * it directly and does NOT own/spawn a server ({@link OpenCodeAgentAdapter.close}
   * then shuts nothing down, but still marks the adapter closed — post-close
   * calls reject). When omitted, the adapter lazily `createOpencode()`s a
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
 *   model: { providerID: "openai", modelID: "gpt-5.4-mini" },
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
   * Per-thread OpenCode session creation, keyed `threadId` → in-flight-or-resolved
   * `Promise<session.id>`. Storing the PROMISE (not the resolved id) dedupes a
   * check-then-create race: two concurrent first-calls on the same thread share
   * ONE `session.create` instead of both creating (one-session-per-thread). The
   * adapter instance is reused across a scenario's turns, so this persists for the
   * conversation's lifetime; evicted on a failed create or a continuation prompt
   * failure so the next turn rebuilds the session.
   */
  private sessions = new Map<string, Promise<string>>();

  /**
   * Memoized auto-spawned server promise — set only when no `client` is
   * injected and the adapter spawns its own OpenCode server. Memoizing the
   * PROMISE (not the resolved handle) makes concurrent first `call`s share one
   * spawn instead of racing.
   */
  private serverPromise: Promise<OwnedServer> | null = null;

  /**
   * Set once {@link close} runs — the adapter is terminal after close(). The
   * full close contract (why post-close calls reject on BOTH ownership paths)
   * lives on {@link close}; other sites point there.
   */
  private closed = false;

  constructor(private config: OpenCodeAgentAdapterConfig) {
    super();
  }

  /** The effective logger (injected or no-op). */
  private get logger(): OpenCodeLogger {
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

  /** `query.directory` payload scoping the agent to the configured working directory (always set — the field is required). */
  private directoryQuery(): { directory: string } {
    return { directory: this.config.workingDirectory };
  }

  /**
   * Validate `config.timeout` eagerly, BEFORE any RPC, and return the validated
   * value. A null timeout is unbounded (returns undefined); a non-positive or
   * non-finite value (e.g. an explicitly-set `0`) throws so a bad timeout fails
   * loudly rather than being silently ignored by a truthiness check — the same
   * timeout validation the sibling Claude Code adapter (`claude-code/`) performs.
   *
   * Returning the value (rather than re-reading `config.timeout` at the signal
   * site) keeps "the value validated" and "the value used" the same number:
   * `config` is a caller-held mutable reference, and the two are now separated
   * by the `ensureClient` / `resolveSessionId` awaits.
   */
  private validateTimeout(): number | undefined {
    const timeout = this.config.timeout;
    if (timeout == null) return undefined;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(
        `OpenCodeAgentAdapter timeout must be a positive, finite number of milliseconds; received ${timeout}`,
      );
    }
    return timeout;
  }

  /**
   * Evict a thread's stored session promise so the next turn rebuilds it.
   *
   * When `promise` is supplied, deletes ONLY if it is still the stored entry
   * (identity guard) — so a newer create promise that replaced it is never
   * clobbered. With no `promise`, deletes unconditionally (used when triaging a
   * failed continuation prompt, where the stored entry is the one to drop).
   */
  private evictSession(threadId: string, promise?: Promise<string>): void {
    if (promise === undefined) {
      this.sessions.delete(threadId);
      return;
    }
    if (this.sessions.get(threadId) === promise) {
      this.sessions.delete(threadId);
    }
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
    // A stored promise (in-flight OR resolved) means the session already exists
    // or is being created for this thread → a continuation turn that awaits the
    // same `session.create`. This closes the check-then-create race.
    const existing = this.sessions.get(threadId);
    if (existing) {
      return { sessionId: await existing, isContinuation: true };
    }

    const query = this.directoryQuery();
    const creating = (async () => {
      const created = await client.session.create({
        body: { title: `scenario:${threadId}` },
        query,
      });
      if (created.error || !created.data?.id) {
        throw new Error(
          `OpenCode session.create failed for thread "${threadId}": ${describeError(
            created.error,
          )}`,
        );
      }
      return created.data.id;
    })();
    this.sessions.set(threadId, creating);

    try {
      const sessionId = await creating;
      return { sessionId, isContinuation: false };
    } catch (err) {
      // Create failed — evict the rejected promise so a later turn retries
      // instead of awaiting a permanently-rejected create. Identity-guarded so a
      // newer create promise (if any) is not clobbered.
      this.evictSession(threadId, creating);
      throw err;
    }
  }

  /**
   * Process the conversation and return OpenCode's assistant text.
   *
   * @param input - Scenario agent input (conversation history etc.).
   * @returns The concatenated assistant-visible text as a string.
   */
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    // close() is terminal (full contract on close()) — reject post-close calls
    // immediately with the real cause instead of an opaque downstream failure.
    if (this.closed) {
      throw new Error(
        "OpenCodeAgentAdapter is closed — no calls are accepted after close(). " +
          "Create a new adapter instance for further calls.",
      );
    }

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

    // Validate the timeout eagerly, before any RPC, so a bad `timeout` (e.g. 0)
    // fails fast instead of after a session.create. The abort budget itself is
    // started later (just before the prompt) so it covers ONLY the prompt — the
    // spawn and session.create must not consume it.
    const timeoutMs = this.validateTimeout();

    const client = await this.ensureClient();
    const { sessionId, isContinuation } = await this.resolveSessionId(
      input.threadId,
      client,
    );

    this.logger.log(
      `OpenCode prompting session ${sessionId} (thread ${input.threadId})`,
    );

    const query = this.directoryQuery();
    // Start the timeout budget HERE, immediately before the prompt, so the
    // preceding spawn + session.create do not eat into it. Built from the value
    // `validateTimeout()` already checked, not a fresh read of the mutable
    // `config`, so validated-value == used-value across the awaits above.
    const signal =
      timeoutMs != null ? AbortSignal.timeout(timeoutMs) : undefined;
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: this.config.model,
        parts: [{ type: "text", text: promptText }],
      },
      query,
      // Best-effort cancellation: AbortSignal.timeout is a valid prompt option
      // (it survives on RequestOptions). If the server ignores it, the call
      // still settles when the prompt resolves.
      ...(signal ? { signal } : {}),
    });

    return this.interpretPromptResult(result, input.threadId, isContinuation);
  }

  /**
   * Triage a resolved `session.prompt` result into assistant text (or a throw).
   *
   * Two error layers then the success path:
   *  1. Transport (`result.error`) — on a continuation, evict the stale session
   *     so the next turn recreates it, then throw the prompt-failed error.
   *  2. Semantic (`result.data.info.error`) — HTTP 200 but a provider/runtime
   *     error; throw it by name.
   *  3. Success — return the concatenated text parts; if there are parts but no
   *     visible text (e.g. a tool-only turn) return a non-empty readable
   *     fallback (R3); only a parts-less completion is a genuine empty response.
   */
  private interpretPromptResult(
    result: PromptResult,
    threadId: string,
    isContinuation: boolean,
  ): string {
    // Layer 1 — transport error. Evict a stale continuation session so the next
    // turn recreates it, then surface a friendly error.
    if (result.error) {
      if (isContinuation) {
        this.evictSession(threadId);
      }
      throw new Error(
        `OpenCode prompt failed: ${describeError(result.error)}`,
      );
    }

    // Layer 2 — semantic error: HTTP 200 but the assistant message carries a
    // provider/runtime error (and usually empty text). Name the variant.
    const infoError = result.data?.info?.error;
    if (infoError) {
      throw new Error(`OpenCode returned an error: ${describeError(infoError)}`);
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
   * Tear down any server this adapter spawned, and mark the adapter closed.
   * Call it in a scenario's teardown (e.g. `afterAll`).
   *
   * The full close contract — stated once, here; other sites point at this:
   *  - Owned server (no `client` injected): awaits the memoized spawn and
   *    closes the server. A post-close call would hit the torn-down server and
   *    surface as an opaque transport error, so it rejects with a clear
   *    closed-adapter error instead.
   *  - Injected `client`: nothing is shut down (the injector owns its server),
   *    but the adapter is still terminal — post-close calls reject by
   *    contract, not because anything broke. Create a new adapter instance to
   *    keep calling.
   *  - Idempotent: repeat `close()` calls return immediately; the owned server
   *    is closed at most once.
   *  - In-flight calls are not cancelled: sequencing teardown (await the run,
   *    then close) is the caller's contract — ADR-005 §10. An overlapping call
   *    fails loudly at the transport layer rather than corrupting state.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (!this.serverPromise) {
      return;
    }
    try {
      const { server } = await this.serverPromise;
      server.close();
    } catch {
      // The server never started (spawn failed) — nothing to close.
    }
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
function extractNewUserText(newMessages: ModelMessage[]): string {
  return newMessages
    .filter((m) => m.role === "user")
    .map((m) => renderContent(m.content))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

/**
 * Render a USER message's content to text for the OpenCode prompt.
 *
 * A string is returned as-is; an array of content blocks keeps only the text
 * blocks (joined by newlines). Non-text blocks (image/file) are dropped — user
 * turns are prose and only the text is forwarded to opencode. `extractNewUserText`
 * only ever feeds USER-role content here, which never carries tool-call /
 * tool-result / reasoning blocks, so those need no handling.
 */
function renderContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (
        block && typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return ""; // user turns are text; non-text blocks (image/file) are not forwarded to the prompt
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Concatenate the visible assistant text from an OpenCode response's parts.
 *
 * Keeps ONLY `type === "text"` parts that are not `ignored`, joins their `.text`
 * with newlines, and SKIPS every other part type (tool, reasoning, step-start,
 * step-finish, file, …) WITHOUT throwing — a real reply interleaves those and
 * only the text parts are the visible assistant message. Narrows on the `Part`
 * union discriminant (`type === "text"`) rather than casting to
 * `Record<string, unknown>`, restoring compile-time safety: if the SDK renames
 * or adds a text variant, the build fails here instead of silently dropping text.
 */
function partsToText(parts: Part[] | undefined): string {
  return (parts ?? [])
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && p.ignored !== true)
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n");
}

/**
 * Readable label for a non-text OpenCode part, used ONLY for the R3 empty-text
 * fallback (a completion with parts but no visible text). Surfaces the part type
 * and, when present, a name/tool/path hint — never returns "" for a real part.
 */
function renderNonTextPart(part: unknown): string {
  if (!part || typeof part !== "object") return stringifyValue(part);
  const p = part as Record<string, unknown>;
  const type = typeof p["type"] === "string" ? (p["type"] as string) : "part";
  const hint = p["tool"] ?? p["name"] ?? p["path"] ?? p["filename"];
  return typeof hint === "string" && hint.length > 0
    ? `[${type}: ${hint}]`
    : `[${type}]`;
}

/**
 * Describe an error object of unknown/varying shape for a friendly message.
 *
 * Used for BOTH layers: transport errors (`result.error` — and `created.error`
 * at the `session.create` site, which may be null when only `!data.id` tripped)
 * AND semantic `info.error` variants (`ProviderAuthError | UnknownError |
 * MessageOutputLengthError | MessageAbortedError | APIError`, each `{ name, data }`).
 * Reads `.name`, `.message`, `.data.message`, and a status/code defensively since
 * shapes vary across endpoints; falls back to `stringifyValue`. The `error == null`
 * guard is reachable via the `session.create` call site (see {@link OpenCodeAgentAdapter}).
 */
function describeError(error: unknown): string {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as Record<string, unknown>;
    const name = typeof e["name"] === "string" ? (e["name"] as string) : undefined;
    const data = e["data"] as Record<string, unknown> | undefined;
    const message =
      (typeof e["message"] === "string" ? (e["message"] as string) : undefined) ??
      (data && typeof data["message"] === "string"
        ? (data["message"] as string)
        : undefined);
    const status = e["status"] ?? e["statusCode"] ?? e["code"];
    const base = name && message ? `${name}: ${message}` : (name ?? message);
    if (base && status !== undefined) return `${base} (status ${String(status)})`;
    if (base) return base;
  }
  return stringifyValue(error);
}
