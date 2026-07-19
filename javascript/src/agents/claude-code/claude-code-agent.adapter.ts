/**
 * Claude Code Agent Adapter for Scenario Testing
 *
 * Adapts the Claude Code CLI (`claude -p --output-format stream-json
 * --verbose`) to the Scenario {@link AgentAdapter} interface. Each `call`
 * formats the conversation into a single prompt, spawns the CLI in a working
 * directory, parses the stream-json stdout (see {@link parseStreamJson}), and
 * returns the concatenated assistant-visible text as a `string`.
 *
 * Session continuation (multiturn): `claude -p` is one-shot — each turn exits
 * on its own — but the CLI keeps server-side session state keyed by a
 * `session_id`. The adapter instance is reused across a scenario's turns, so it
 * keeps a per-thread map (`threadId` → `session_id`):
 *  - First turn for a `threadId`: format the prompt from the FULL history
 *    (`input.messages`) and spawn WITHOUT `--resume`. The CLI stamps a
 *    `session_id` on its `system`/init line; {@link parseStreamJson} surfaces
 *    it and the adapter stores it under the `threadId`.
 *  - Subsequent turns for that `threadId`: pass `--resume <session_id>` and
 *    format the prompt from the DELTA ONLY (`input.newMessages`) — the resumed
 *    session already holds the prior transcript, so re-sending it would
 *    duplicate context. The stored id is refreshed from the response if the CLI
 *    reports one. Distinct `threadId`s keep distinct sessions.
 *  - If a resumed session has vanished server-side (structurally: the terminal
 *    `result` envelope reports `subtype: "error_during_execution"` with a
 *    `No conversation found` error; or, on older CLIs, the same sentence on
 *    stderr), the dead id is evicted. What happens next is the caller's choice
 *    (`replayOnLostSession`, default `false`):
 *      · default — the turn REJECTS with an actionable error. A replay is a real
 *        modality change (see item (g)); under an eval harness we do not perform
 *        it silently.
 *      · opt-in (`replayOnLostSession: true`) — the turn recovers IN PLACE: the
 *        same turn is re-run from the full history against a fresh session. This
 *        must happen inside the turn — `ScenarioExecution` rethrows anything
 *        `call()` throws, aborting the run, so a rejected turn has no successor
 *        to rebuild on.
 *
 * Hardening over the install-orchard reference helper this is ported from:
 *  a. Structured `tool_result` content is rendered readably, never
 *     `[object Object]` (in {@link parseStreamJson}).
 *  b. A `timeout` (default 120000ms) kills the child and rejects with a clear
 *     timeout error.
 *  c. CLI-absent (spawn ENOENT) rejects with a friendly "Claude Code CLI not
 *     found" error, not a raw ENOENT.
 *  d. `--dangerously-skip-permissions` is opt-in via `skipPermissions: true`;
 *     never passed by default.
 *  e. All diagnostics route through an injectable {@link Logger}; absent one,
 *     a no-op logger is used. No `console.*` and no `chalk` anywhere.
 *  f. The parsed stream-json message shape is exported
 *     ({@link ClaudeStreamMessage}, re-exported from `stream-json`).
 *  g. Real multiturn session continuation via `--resume` (see above), instead
 *     of replaying the whole transcript as a fresh prompt every turn. When a
 *     resumed session has vanished, in-turn recovery is available but OPT-IN
 *     (`replayOnLostSession`). Note the fidelity tradeoff: the recovery path
 *     RE-FLATTENS the whole transcript into a `role: content` prompt for a fresh
 *     session, which loses server-side session state (context cache, tool
 *     state) — so a replayed turn is no longer a true `--resume` continuation.
 *     It defaults off precisely because that silent downgrade would corrupt what
 *     an eval harness is measuring.
 */

import { spawn } from "node:child_process";

import type { ModelMessage } from "ai";

import { parseStreamJson, safeStringify } from "./stream-json.js";
import { AgentAdapter, AgentRole } from "../../domain/agents/index.js";
import type { AgentInput, AgentReturnTypes } from "../../domain/agents/index.js";

export type { ClaudeStreamMessage } from "./stream-json.js";

/** Default per-call timeout in milliseconds when `config.timeout` is unset. */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * The sentence naming a vanished session, matched in TWO places: the CLI's
 * `errors[]` on the terminal `result` envelope (the structural, preferred
 * signal) and — as a fallback for older CLIs or a missing envelope — its stderr.
 * Verified against Claude Code 2.1.205: `--resume <id>` for an unknown id both
 * fields `No conversation found with session ID: <id>` in `errors[]` (with
 * `subtype: "error_during_execution"`) and writes it to stderr, exiting 1.
 */
const STALE_SESSION_ERROR = /no conversation found/i;

/**
 * A Claude Code CLI invocation that failed: it exited non-zero, died on a
 * signal, or fielded `is_error: true` on its terminal `result` envelope. Carries
 * the raw exit status and stderr AND the CLI's own structured failure fields off
 * the terminal `result` envelope:
 *  - `subtype` — the envelope's failure class, the CLI's machine-readable label
 *    for what went wrong (e.g. `"error_during_execution"`).
 *  - `errors` — the `errors[]` the CLI fielded on that envelope: its structured
 *    error strings (e.g. `"No conversation found with session ID: <id>"` for a
 *    stale `--resume`).
 * A genuine failure (bad auth, rate limit, unknown model) surfaces as this
 * class; a vanished `--resume` session surfaces as the {@link LostSessionError}
 * subclass, so a caller can branch on `instanceof LostSessionError` rather than
 * string-matching the message.
 *
 * SECURITY — `stderr` and every entry of `errors[]` are UNREDACTED CLI output
 * and may echo sensitive detail (env values, a rejected key); `message` embeds
 * `errors[]` (or, when the envelope carried none, `stderr`). `stderr`, `errors`,
 * and `subtype` are all enumerable (`readonly` ctor params), so they also appear
 * in `JSON.stringify(error)`. Do not log them verbatim to shared/public sinks;
 * redact or drop before a trusted boundary. Note too that `message` is exported
 * to tracing automatically: on a failed `call()` under `scenario.run(...)`,
 * LangWatch records it via `recordException`/`setStatus` with no redaction and
 * no opt-out (systemic fix tracked in #754), so any sensitive CLI output carried
 * in it reaches your configured tracing sink on every failed turn.
 */
export class ClaudeCodeCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
    readonly subtype?: string,
    readonly errors?: string[],
  ) {
    super(message);
    this.name = "ClaudeCodeCliError";
  }
}

/**
 * The specific {@link ClaudeCodeCliError} raised when a `--resume`d session has
 * vanished server-side and `replayOnLostSession` is off (the default): the turn
 * rejects rather than silently rebuilding into a fresh session. Because it is a
 * `ClaudeCodeCliError` subclass, `instanceof ClaudeCodeCliError` stays true
 * while `instanceof LostSessionError` distinguishes THIS failure — the one a
 * caller most often needs to branch on — from a genuine CLI failure (bad auth,
 * rate limit, unknown model).
 *
 * It carries the originating error's `exitCode`/`signal`/`stderr`/`subtype`/
 * `errors` (copied from `cause`) plus the dead `sessionId` and its `threadId` as
 * typed fields, and sets that originating {@link ClaudeCodeCliError} as `cause`.
 */
export class LostSessionError extends ClaudeCodeCliError {
  constructor(
    message: string,
    /** The evicted session id that `--resume` could no longer find. */
    readonly sessionId: string,
    /** The thread whose cached session vanished. */
    readonly threadId: string,
    /** The originating CLI failure; also set as this error's `cause`. */
    cause: ClaudeCodeCliError,
  ) {
    super(
      message,
      cause.exitCode,
      cause.signal,
      cause.stderr,
      cause.subtype,
      cause.errors,
    );
    this.name = "LostSessionError";
    this.cause = cause;
  }
}

/**
 * Whether `error` means the resumed session no longer exists server-side — the
 * one CLI failure a turn can transparently recover from (when
 * `replayOnLostSession` is set), by replaying the full history into a fresh
 * session. A signal death or any other failure is genuine and must surface.
 *
 * Detection order is STRUCTURAL FIRST, stderr fallback second:
 *  1. The terminal `result` envelope reports `subtype: "error_during_execution"`
 *     AND an `errors[]` entry naming a missing conversation. This is the fielded
 *     signal (Claude Code 2.1.205+) and catches the case where the CLI reports
 *     `is_error: true` even on a 0 exit.
 *  2. Fallback (older CLIs / no envelope): a non-zero exit whose stderr carries
 *     the same sentence.
 * A signal death is never a stale session, so it short-circuits to `false`.
 */
function isStaleSessionError(error: unknown): error is ClaudeCodeCliError {
  if (!(error instanceof ClaudeCodeCliError)) return false;
  if (error.signal !== null) return false;
  // 1. Structural: the CLI fielded a missing-conversation error on its envelope.
  if (
    error.subtype === "error_during_execution" &&
    (error.errors ?? []).some((e) => STALE_SESSION_ERROR.test(e))
  ) {
    return true;
  }
  // 2. Fallback: the stderr sentence on a non-zero exit.
  return error.exitCode !== 0 && STALE_SESSION_ERROR.test(error.stderr);
}

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
 * Configuration for {@link ClaudeCodeAgentAdapter}.
 */
export interface ClaudeCodeAgentAdapterConfig {
  /**
   * Directory the Claude Code CLI is spawned in (its `cwd`). Files Claude reads
   * or writes are resolved relative to this.
   */
  workingDirectory: string;

  /**
   * Optional model identifier passed through as `--model <model>`.
   */
  model?: string;

  /**
   * Per-call timeout in milliseconds. On exceed, the child is killed and
   * `call` rejects with a timeout error.
   * @default 120000
   */
  timeout?: number;

  /**
   * When `true`, passes `--dangerously-skip-permissions`. Never passed
   * otherwise. Off by default.
   */
  skipPermissions?: boolean;

  /**
   * What to do when a `--resume`d session has vanished server-side.
   *
   * - `false` (default): reject the turn with an actionable error naming this
   *   flag. Fail-loudly is the default because the alternative is a silent
   *   modality change (see below) under an eval harness.
   * - `true`: recover in place — evict the dead id and re-run the SAME turn from
   *   the full transcript against a fresh session.
   *
   * The recovery re-flattens the whole conversation into a `role: content`
   * prompt for a NEW session, so it loses server-side session state (context
   * cache, tool state): the turn is no longer a true `--resume` continuation.
   * Enable it only when surviving a lost session matters more than that
   * fidelity.
   * @default false
   */
  replayOnLostSession?: boolean;

  /**
   * Optional absolute path to a `SKILL.md` to inject into the working
   * directory before the CLI runs (see `injectSkill`). When omitted, no skill
   * injection occurs.
   */
  skillPath?: string;

  /**
   * Optional logger for all diagnostics. Defaults to a no-op logger (silent).
   */
  logger?: Logger;

  /**
   * Extra CLI args inserted before the prompt argument. Use for flags this
   * config does not model directly.
   */
  extraArgs?: string[];

  /**
   * Path or name of the Claude Code binary. Resolution order:
   * `claudeBin` → `process.env.CLAUDE_BIN` → `"claude"`.
   */
  claudeBin?: string;
}

/**
 * Adapter that runs the Claude Code CLI as a Scenario agent.
 *
 * @example
 * ```typescript
 * const adapter = new ClaudeCodeAgentAdapter({
 *   workingDirectory: "/tmp/project",
 *   model: "claude-sonnet-4-5",
 *   skipPermissions: true,
 * });
 * await scenario.run({
 *   agents: [adapter, scenario.userSimulatorAgent(), scenario.judgeAgent({ criteria: [...] })],
 *   script: [scenario.user("..."), scenario.agent(), scenario.judge()],
 * });
 * ```
 */
export class ClaudeCodeAgentAdapter extends AgentAdapter {
  role: AgentRole = AgentRole.AGENT;
  name = "ClaudeCodeAgent";

  /**
   * Per-thread Claude Code session ids (`threadId` → `session_id`). Populated
   * after a thread's first turn and consulted on every subsequent turn to pass
   * `--resume <session_id>`. The adapter instance is reused across a scenario's
   * turns, so this persists for the conversation's lifetime.
   */
  private sessions = new Map<string, string>();

  constructor(private config: ClaudeCodeAgentAdapterConfig) {
    super();
  }

  /** The effective logger (injected or no-op). */
  private get logger(): Logger {
    return this.config.logger ?? noopLogger;
  }

  /** Resolve the binary to spawn. */
  private resolveBin(): string {
    return this.config.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";
  }

  /**
   * Build the CLI argv. Order is fixed:
   * `-p --output-format stream-json --verbose [--model M] [--dangerously-skip-permissions] [--resume <id>] [...extraArgs] <prompt>`.
   *
   * `--resume <id>` is inserted only on a continuation turn (when
   * `resumeSessionId` is set), after the modelled flags and before
   * `extraArgs`/prompt — so a first-turn (no-resume) argv is unchanged.
   */
  private buildArgs(prompt: string, resumeSessionId?: string): string[] {
    const { model, skipPermissions, extraArgs } = this.config;
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(model ? ["--model", model] : []),
      ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
      ...(extraArgs ?? []),
      prompt,
    ];
  }

  /**
   * Process the conversation and return Claude Code's assistant text.
   *
   * A thread's first turn sends the FULL history and lets the CLI mint a
   * session; later turns `--resume` it and send only the delta.
   *
   * This method owns ALL session-map policy — every read, write, and eviction of
   * `this.sessions` happens here; {@link runTurn} is a pure one-spawn helper that
   * mutates no instance state. A resume turn evicts its id ONLY when the failure
   * is a genuinely stale session ({@link isStaleSessionError}); every other
   * failure (auth, rate limit, unknown model, signal, timeout, or the
   * client-side empty-delta guard that never even spawned) leaves the cached
   * session untouched — the server session may well still be valid.
   *
   * On a stale session the behaviour is `replayOnLostSession`'s to decide: by
   * default the turn rejects; when opted in, the rebuild happens INSIDE this same
   * turn. It cannot be deferred to "the next turn": `ScenarioExecution` rethrows
   * whatever an adapter's `call()` throws, which aborts the run — so a rejected
   * turn has no successor to rebuild on.
   *
   * @param input - Scenario agent input (conversation history etc.).
   * @returns The concatenated assistant-visible text as a string.
   */
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    // Validate before anything is spawned or any timer is scheduled, so a bad
    // config fails loudly and identically on every turn.
    const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `ClaudeCodeAgentAdapter timeout must be a positive, finite number of milliseconds; received ${timeoutMs}`,
      );
    }

    const { threadId } = input;
    const resumeSessionId = this.sessions.get(threadId);

    if (resumeSessionId !== undefined) {
      try {
        // Continuation turn: the resumed session already holds the prior
        // transcript, so send ONLY the delta (`newMessages`).
        const { text, sessionId } = await this.runTurn(
          input.newMessages,
          resumeSessionId,
          timeoutMs,
        );
        if (sessionId) this.sessions.set(threadId, sessionId);
        // LOAD-BEARING return: without it a successful resume would fall through
        // to the shared full-history rebuild below (a second spawn). See the
        // fall-through INVARIANT note and its "successful resume spawns exactly
        // once" regression test.
        return text;
      } catch (error) {
        // A non-stale failure surfaces AS-IS and leaves the session cached: it
        // may still be valid (a rate limit, a signal, a timeout, or the
        // empty-delta guard that never contacted the CLI). Evicting here would
        // silently downgrade the next turn to a from-scratch prompt.
        if (!isStaleSessionError(error)) throw error;
        // The session is genuinely gone server-side — evict the dead id.
        this.sessions.delete(threadId);
        if (!this.config.replayOnLostSession) {
          // Default: fail loudly. A replay is a real modality change (it loses
          // server-side session state), so under an eval harness we do not do it
          // silently; the caller opts in via `replayOnLostSession`. Throw the
          // typed LostSessionError (a ClaudeCodeCliError subclass) so a caller
          // can branch on `instanceof LostSessionError`, carrying the dead id,
          // its thread, and the originating failure as `cause`.
          throw new LostSessionError(
            `Claude Code session ${resumeSessionId} for thread ${threadId} no longer exists ` +
              `(--resume reported: No conversation found). Set replayOnLostSession: true to rebuild ` +
              `this turn from the full transcript instead — note that replays the conversation as a ` +
              `flat prompt into a NEW session and loses server-side session state (context cache, ` +
              `tool state), so the turn is no longer a true session continuation.`,
            resumeSessionId,
            threadId,
            error,
          );
        }
        this.logger.warn(
          `Claude Code session ${resumeSessionId} no longer exists; ` +
            `replayOnLostSession is set, so rebuilding this turn from full history ` +
            `into a fresh session (server-side session state is lost).`,
        );
        // INVARIANT (regression-guarded): only a stale-session catch that opted
        // into replay may fall through to the shared full-history rebuild below.
        // The SUCCESS path above returns `text` before it can reach here, so a
        // successful resume must NOT run the rebuild. The "successful resume
        // spawns exactly once" test pins this, failing the moment that
        // load-bearing `return` is dropped.
      }
    }

    // First turn for this thread, or the opt-in rebuild after a vanished
    // session: send the full history and let the CLI mint a fresh session id to
    // resume next.
    const { text, sessionId } = await this.runTurn(
      input.messages,
      undefined,
      timeoutMs,
    );
    if (sessionId) this.sessions.set(threadId, sessionId);
    return text;
  }

  /**
   * Run exactly ONE `claude -p` invocation and resolve its assistant text plus
   * the session id it reported. PURE w.r.t. instance state: it reads config but
   * mutates nothing on `this` — the caller ({@link call}) owns all session-map
   * policy. It therefore neither reads nor evicts `this.sessions`.
   *
   * @param promptMessages - The messages to serialize into the prompt. The
   *   empty-prompt guard is computed against this SAME set, so an empty resume
   *   delta fails loudly rather than degenerating to `claude -p --resume <id> ""`.
   * @returns `{ text, sessionId }` on success. `sessionId` is only ever set from
   *   a SUCCESSFUL run (the failure paths reject first), so the caller never
   *   persists an id minted by a failed turn.
   * @throws {ClaudeCodeCliError} when the child dies on a signal, exits non-zero,
   *   or fields `is_error: true` on its terminal `result` envelope.
   */
  private runTurn(
    promptMessages: ModelMessage[],
    resumeSessionId: string | undefined,
    timeoutMs: number,
  ): Promise<{ text: string; sessionId?: string }> {
    const prompt = formatMessagesAsPrompt(promptMessages);

    // Agent-first / empty-input guard. The realtime sibling handles a missing
    // initial turn by making the agent SPEAK first (`response.create` against
    // loaded session instructions). A `claude -p` CLI has no such channel — it
    // requires a prompt — so `claude -p ""` (or `claude -p --resume <id> ""`)
    // would be meaningless and would silently mask a wiring bug (agent placed
    // first with no `user()` step, or a resume turn with no new delta). We
    // therefore reject loudly rather than guess a default prompt.
    if (!hasRenderableContent(prompt)) {
      throw new Error(
        "ClaudeCodeAgentAdapter received no messages to send to the CLI. " +
          "The Claude Code CLI is prompt-driven and cannot open a conversation " +
          "on its own; ensure a user turn precedes the agent (e.g. a " +
          "scenario.user(...) step before scenario.agent()).",
      );
    }

    const bin = this.resolveBin();
    const args = this.buildArgs(prompt, resumeSessionId);
    const cwd = this.config.workingDirectory;
    const logger = this.logger;

    logger.log(`Starting claude in: ${cwd}`);

    return new Promise<{ text: string; sessionId?: string }>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Accumulate raw stdout chunks and decode ONCE at close: a multibyte
      // UTF-8 character split across two `data` events would corrupt if each
      // chunk were `toString`-ed independently.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Graceful terminate first…
        child.kill();
        // …then a hard SIGKILL shortly after so a wedged child can't leak.
        // Cleared in `finish` if the child exits on its own first.
        sigkillTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        sigkillTimer.unref?.();
        reject(
          new Error(
            `Claude Code CLI timed out after ${timeoutMs}ms in ${cwd}`,
          ),
        );
      }, timeoutMs);

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        fn();
      };

      child.stdout?.on("data", (data: Buffer) => {
        stdoutChunks.push(data);
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderrChunks.push(data);
        logger.warn(`Claude Code stderr: ${data.toString()}`);
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          finish(() =>
            reject(
              new Error(
                `Claude Code CLI not found: ${bin}. Install it or set claudeBin/CLAUDE_BIN.`,
              ),
            ),
          );
          return;
        }
        finish(() => reject(err));
      });

      child.on("close", (exitCode, signal) => {
        finish(() => {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          // Parse stdout FIRST: the CLI's terminal `result` envelope fields the
          // run's status (`is_error`/`subtype`/`errors`) more reliably than the
          // exit code — a stale `--resume`, for one, can surface as
          // `is_error: true`. Trusting the exit code alone would resolve such a
          // run as a silent empty-text success and even store its session id.
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          const { text, sessionId, result } = parseStreamJson(stdout, logger);

          // A turn FAILS if it died on a signal, exited non-zero, or the CLI's
          // own envelope says so. Failures reject with the structured error
          // (carrying `subtype`/`errors`) so `call` can tell a vanished session
          // (recoverable, in-turn, opt-in) apart from a real failure (surface
          // it). Evicting the stale id is `call`'s job — the only frame that
          // knows whether this was a resume turn.
          const failedBySignal = signal !== null;
          const failedByExit = exitCode !== 0 && exitCode !== null;
          const failedByResult = result.isError === true;

          if (failedBySignal || failedByExit || failedByResult) {
            // Prefer the envelope's fielded `errors[]` for the message; fall
            // back to captured stderr when the envelope carried none.
            const detailSource = result.errors?.length
              ? result.errors.join("; ")
              : stderr;
            const detail = detailSource ? `: ${detailSource}` : "";
            const summary = failedBySignal
              ? `Claude Code CLI was terminated by signal ${signal}${detail}`
              : failedByExit
                ? `Claude Code CLI failed with exit code ${exitCode}${detail}`
                : `Claude Code CLI reported an error result${
                    result.subtype ? ` (${result.subtype})` : ""
                  }${detail}`;
            reject(
              new ClaudeCodeCliError(
                summary,
                exitCode,
                signal,
                stderr,
                result.subtype,
                result.errors,
              ),
            );
            return;
          }

          // Success. Return the session id the CLI reported (if any) for `call`
          // to persist and `--resume` next turn. We deliberately do NOT pin a
          // self-generated `--session-id`: capture-then-resume only ever returns
          // an id from a run that SUCCEEDED (the failure paths above rejected
          // first), so a failed or partially-created session can never be left
          // behind for a later `--resume` to trip over.
          resolve({ text, sessionId });
        });
      });
    });
  }
}

/**
 * Render a single `ai`-SDK message content part to a readable string.
 *
 * Mirrors the OUTPUT parser's intent ({@link parseStreamJson} in
 * `stream-json.ts`): structured parts are made readable rather than dropped, so
 * an assistant tool-call turn or a `tool` result is preserved in the prompt
 * instead of collapsing to a bare label. Note the `ai`-SDK part discriminators
 * are HYPHENATED (`tool-call`, `tool-result`) — distinct from Claude Code's
 * underscored stream-json blocks (`tool_use`, `tool_result`) — so the rendering
 * is shaped here while the circular-safe `safeStringify` helper is reused.
 */
function renderContentPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";

  const p = part as Record<string, unknown>;
  switch (p["type"]) {
    case "text":
    case "reasoning":
      return typeof p["text"] === "string" ? p["text"] : "";
    case "tool-call":
      return `[tool-call: ${String(p["toolName"] ?? "unknown")}(${safeStringify(
        p["input"],
      )})]`;
    case "tool-result":
      return `[tool-result: ${String(p["toolName"] ?? "unknown")} -> ${safeStringify(
        p["output"] ?? p["result"],
      )}]`;
    case "file":
      return `[file: ${String(p["mediaType"] ?? "application/octet-stream")}]`;
    default:
      // Unknown part: still surface it readably rather than dropping it.
      return safeStringify(part);
  }
}

/**
 * Render a single message's content. A string is returned as-is; an array of
 * parts is rendered part-by-part via {@link renderContentPart} (text AND
 * structured tool parts) and joined. A message whose content is only tool
 * parts therefore renders to those tool parts — never an empty string.
 */
function extractText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(renderContentPart).filter(Boolean).join("\n");
}

/**
 * Format the full message history into a single `role: content` prompt block,
 * one message per double-newline-separated paragraph. Array content is rendered
 * via {@link extractText} (text + structured parts).
 */
function formatMessagesAsPrompt(messages: ModelMessage[]): string {
  return messages
    .map((message) => `${message.role}: ${extractText(message.content)}`)
    .join("\n\n");
}

/**
 * Whether a formatted prompt carries actual content to send to the CLI.
 *
 * Returns false for an empty prompt (no messages) AND for one whose every line
 * is just a bare `role:` label with no rendered content (messages that produced
 * nothing renderable) — both of which would degenerate to `claude -p ""`.
 */
function hasRenderableContent(prompt: string): boolean {
  return prompt
    .split("\n")
    .some((line) => line.replace(/^[^:]*:/, "").trim().length > 0);
}
