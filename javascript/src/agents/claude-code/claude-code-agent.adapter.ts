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
 *  - If a resumed session has vanished server-side (the CLI exits non-zero with
 *    `No conversation found with session ID`), the turn recovers IN PLACE: the
 *    dead id is evicted and the same turn is re-run from the full history
 *    against a fresh session. This must happen inside the turn — `ScenarioExecution`
 *    rethrows anything `call()` throws, aborting the run, so a rejected turn has
 *    no successor to rebuild on.
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
 *     of replaying the whole transcript as a fresh prompt every turn, with
 *     in-turn recovery when a resumed session has vanished.
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
 * What the CLI writes to stderr when `--resume <id>` names a session it cannot
 * find (verified against Claude Code 2.1.205, which also exits 1):
 * `No conversation found with session ID: <id>`.
 */
const STALE_SESSION_STDERR = /no conversation found/i;

/**
 * A Claude Code CLI invocation that exited non-zero or died on a signal. Carries
 * the raw exit status and stderr so a caller can tell a vanished session apart
 * from a genuine failure (bad auth, rate limit, unknown model).
 */
export class ClaudeCodeCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ClaudeCodeCliError";
  }
}

/**
 * Whether `error` means the resumed session no longer exists server-side — the
 * one CLI failure a turn can transparently recover from, by replaying the full
 * history into a fresh session. A signal death or any other non-zero exit is a
 * genuine failure and must surface.
 */
function isStaleSessionError(error: unknown): error is ClaudeCodeCliError {
  return (
    error instanceof ClaudeCodeCliError &&
    !error.signal &&
    error.exitCode !== 0 &&
    STALE_SESSION_STDERR.test(error.stderr)
  );
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
   * If a resumed session has vanished server-side, the rebuild happens INSIDE
   * this same turn. It cannot be deferred to "the next turn": `ScenarioExecution`
   * rethrows whatever an adapter's `call()` throws, which aborts the run — so a
   * rejected turn has no successor to rebuild on.
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

    const resumeSessionId = this.sessions.get(input.threadId);

    if (resumeSessionId !== undefined) {
      try {
        // Continuation turn: the resumed session already holds the prior
        // transcript, so send ONLY the delta (`newMessages`).
        return await this.runTurn(
          input,
          input.newMessages,
          resumeSessionId,
          timeoutMs,
        );
      } catch (error) {
        // Never re-resume an id whose turn just failed.
        this.sessions.delete(input.threadId);
        // A genuine failure (auth, rate limit, unknown model, signal) is the
        // caller's to see — surfacing it beats masking it behind a silent retry.
        if (!isStaleSessionError(error)) throw error;
        this.logger.warn(
          `Claude Code session ${resumeSessionId} no longer exists; ` +
            `rebuilding it from full history for this turn.`,
        );
        // fall through to the full-history rebuild below
      }
    }

    // First turn for this thread, or the rebuild after a vanished session: send
    // the full history and let the CLI mint a fresh session id to resume next.
    return await this.runTurn(input, input.messages, undefined, timeoutMs);
  }

  /**
   * Run exactly ONE `claude -p` invocation and resolve its assistant text,
   * capturing the session id it reports.
   *
   * @param promptMessages - The messages to serialize into the prompt. The
   *   empty-prompt guard is computed against this SAME set, so an empty resume
   *   delta fails loudly rather than degenerating to `claude -p --resume <id> ""`.
   * @throws {ClaudeCodeCliError} when the child exits non-zero or dies on a signal.
   */
  private runTurn(
    input: AgentInput,
    promptMessages: ModelMessage[],
    resumeSessionId: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
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

    return new Promise<string>((resolve, reject) => {
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
          const detail = stderr ? `: ${stderr}` : "";
          // Failures reject with the structured error so `call` can tell a
          // vanished session (recoverable, in-turn) apart from a real failure
          // (surface it). Evicting the stale id is `call`'s job — it is the
          // only frame that knows whether this was a resume turn.
          if (signal) {
            reject(
              new ClaudeCodeCliError(
                `Claude Code CLI was terminated by signal ${signal}${detail}`,
                exitCode,
                signal,
                stderr,
              ),
            );
            return;
          }
          if (exitCode !== 0 && exitCode !== null) {
            reject(
              new ClaudeCodeCliError(
                `Claude Code CLI failed with exit code ${exitCode}${detail}`,
                exitCode,
                signal,
                stderr,
              ),
            );
            return;
          }
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          const { text, sessionId } = parseStreamJson(stdout, logger);
          // Capture/refresh the thread's session id from the CLI's own output
          // and resume it next turn (--resume). We deliberately do NOT pin a
          // self-generated --session-id: capture-then-resume can only ever
          // resume an id the CLI just confirmed (0-exit), avoiding a pin/create
          // split-brain where a turn-1 failure leaves a never-created id that
          // --resume can't find.
          if (sessionId) {
            this.sessions.set(input.threadId, sessionId);
          }
          resolve(text);
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
