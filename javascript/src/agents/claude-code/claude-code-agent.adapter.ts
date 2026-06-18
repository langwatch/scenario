/**
 * Claude Code Agent Adapter for Scenario Testing
 *
 * Adapts the Claude Code CLI (`claude -p --output-format stream-json
 * --verbose`) to the Scenario {@link AgentAdapter} interface. Each `call`
 * formats the conversation into a single prompt, spawns the CLI in a working
 * directory, parses the stream-json stdout (see {@link parseStreamJson}), and
 * returns the concatenated assistant-visible text as a `string`.
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
   * `-p --output-format stream-json --verbose [--model M] [--dangerously-skip-permissions] [...extraArgs] <prompt>`.
   */
  private buildArgs(prompt: string): string[] {
    const { model, skipPermissions, extraArgs } = this.config;
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(model ? ["--model", model] : []),
      ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
      ...(extraArgs ?? []),
      prompt,
    ];
  }

  /**
   * Process the conversation and return Claude Code's assistant text.
   *
   * @param input - Scenario agent input (conversation history etc.).
   * @returns The concatenated assistant-visible text as a string.
   */
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    const prompt = formatMessagesAsPrompt(input.messages);
    const bin = this.resolveBin();
    const args = this.buildArgs(prompt);
    const cwd = this.config.workingDirectory;
    const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
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

      child.on("close", (exitCode) => {
        finish(() => {
          if (exitCode !== 0 && exitCode !== null) {
            const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
            const detail = stderr ? `: ${stderr}` : "";
            reject(
              new Error(
                `Claude Code CLI failed with exit code ${exitCode}${detail}`,
              ),
            );
            return;
          }
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          const { text } = parseStreamJson(stdout, logger);
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
