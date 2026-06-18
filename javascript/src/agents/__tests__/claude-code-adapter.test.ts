/**
 * Unit tests for the Claude Code agent adapter (`ClaudeCodeAgentAdapter`).
 *
 * Creds-free mock strategy (no real CLI, no spawn): `child_process.spawn` is
 * mocked to return a `FakeChild` — an EventEmitter exposing `.stdout`/`.stderr`
 * (themselves EventEmitters you push `data` into), `.kill()`, and emitting
 * `close`/`error`. The mock records the `spawn` argv so we can assert on flags.
 * Mirrors the fake-transport STYLE of `realtime-adapter-frames.test.ts`, but for
 * a spawned child rather than a realtime transport.
 *
 * Coverage:
 *  1. argv: stream-json always; `--dangerously-skip-permissions` only when
 *     `skipPermissions:true`; `--model` only when `model` set.
 *  2. stream-json parsing preserves array-shaped `tool_result` content (never
 *     `[object Object]`).
 *  3. unknown event → `logger.warn`, no throw, known content still returned.
 *  4. CLI-absent (spawn ENOENT) → reject with "Claude Code CLI not found".
 *  5. timeout → reject with a timeout error AND `child.kill()` called.
 *  6. injected logger receives diagnostics; `console.*` is never used.
 *  7. `assertSkillWasRead` passes on evidence, throws (naming the skill) without.
 *
 * Plus an env-gated integration test (skipped unless `RUN_CLAUDE_CODE_E2E=1`)
 * that runs a real `scenario.run(...)` with `claudeCodeAgent` and a real judge.
 */

import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import type { ModelMessage } from "ai";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";

// --- spawn mock -------------------------------------------------------------
//
// The mock block MUST precede the source imports below: those imports pull in
// the adapter, whose module graph loads `node:child_process` at evaluation
// time. `vi.hoisted` creates the mock fn before hoisting so the factory and the
// tests share the exact same reference (the classic vitest ESM fix). The mock
// specifier matches the adapter's source specifier exactly — `node:child_process`
// — mirroring `voice/__tests__/playback.test.ts`, which mocks the same builtin
// and likewise places its source imports after the mock. The `default` key
// covers any default-interop reference.

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn<typeof spawn>(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

import {
  AgentRole,
  type AgentInput,
  type ScenarioExecutionStateLike,
} from "../../domain/index.js";
import {
  ClaudeCodeAgentAdapter,
  parseStreamJson,
  assertSkillWasRead,
  type Logger,
} from "../claude-code/index.js";

/**
 * A fake spawned child: an EventEmitter exposing `.stdout`/`.stderr` (each an
 * EventEmitter) and a spied `.kill()`. Tests drive it by pushing `data` and
 * emitting `close`/`error`.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();

  /** Push a chunk to stdout (as the CLI would). */
  pushStdout(chunk: string): void {
    this.stdout.emit("data", Buffer.from(chunk));
  }

  /** Push a chunk to stderr. */
  pushStderr(chunk: string): void {
    this.stderr.emit("data", Buffer.from(chunk));
  }

  /** Emit close with an exit code (default 0). */
  close(code = 0): void {
    this.emit("close", code);
  }

  /** Emit an error (e.g. spawn ENOENT). */
  fail(code: string): void {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    this.emit("error", err);
  }
}

/** Install the spawn mock to return `child` and record the call. */
function withChild(child: FakeChild): void {
  spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
}

/** The argv (3rd positional) the adapter passed to spawn on the last call. */
function lastArgv(): string[] {
  const call = spawnMock.mock.calls.at(-1);
  return (call?.[1] as string[]) ?? [];
}

// --- input fixtures ---------------------------------------------------------

function makeInput(messages: ModelMessage[]): AgentInput {
  return {
    threadId: "claude-code-thread",
    messages,
    newMessages: messages,
    requestedRole: AgentRole.AGENT,
    scenarioState: {} as unknown as AgentInput["scenarioState"],
    scenarioConfig: {
      name: "claude-code",
      description: "A test.",
    } as unknown as AgentInput["scenarioConfig"],
  } as AgentInput;
}

const SIMPLE_INPUT = makeInput([{ role: "user", content: "hello" }]);

/** A spy logger matching the structural `Logger` type. */
function spyLogger(): Logger & { log: Mock<(...args: unknown[]) => void>; warn: Mock<(...args: unknown[]) => void> } {
  const log = vi.fn<(...args: unknown[]) => void>();
  const warn = vi.fn<(...args: unknown[]) => void>();
  return { log, warn };
}

beforeEach(() => {
  spawnMock.mockReset();
});

// --- 1. argv ----------------------------------------------------------------

describe("ClaudeCodeAgentAdapter argv", () => {
  it("always requests stream-json and omits --dangerously-skip-permissions by default", async () => {
    const child = new FakeChild();
    withChild(child);

    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });
    const p = adapter.call(SIMPLE_INPUT);
    child.close(0);
    await p;

    const argv = lastArgv();
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--model");
  });

  it("includes --dangerously-skip-permissions only when skipPermissions:true", async () => {
    const child = new FakeChild();
    withChild(child);

    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      skipPermissions: true,
    });
    const p = adapter.call(SIMPLE_INPUT);
    child.close(0);
    await p;

    expect(lastArgv()).toContain("--dangerously-skip-permissions");
  });

  it("includes --model <model> when model is set", async () => {
    const child = new FakeChild();
    withChild(child);

    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      model: "claude-sonnet-4-5",
    });
    const p = adapter.call(SIMPLE_INPUT);
    child.close(0);
    await p;

    const argv = lastArgv();
    const modelIdx = argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(argv[modelIdx + 1]).toBe("claude-sonnet-4-5");
  });

  it("resolves the binary from claudeBin over CLAUDE_BIN over 'claude'", async () => {
    const child = new FakeChild();
    withChild(child);

    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      claudeBin: "/custom/claude",
    });
    const p = adapter.call(SIMPLE_INPUT);
    child.close(0);
    await p;

    expect(spawnMock.mock.calls.at(-1)?.[0]).toBe("/custom/claude");
  });
});

// --- 2. stream-json parsing -------------------------------------------------

describe("ClaudeCodeAgentAdapter stream-json parsing", () => {
  it("preserves array-shaped tool_result content (not [object Object])", async () => {
    const child = new FakeChild();
    withChild(child);

    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Here is the answer" }] },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "FILE_CONTENTS_MARKER" },
                { type: "text", text: "line two" },
              ],
            },
          ],
        },
      }),
    ].join("\n");

    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });
    const p = adapter.call(SIMPLE_INPUT);
    child.pushStdout(lines + "\n");
    child.close(0);
    const text = (await p) as string;

    expect(text).toContain("Here is the answer");
    expect(text).toContain("FILE_CONTENTS_MARKER");
    expect(text).toContain("line two");
    expect(text).not.toContain("[object Object]");
  });

  it("parseStreamJson renders tool_result objects readably as well", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: { stdout: "OBJECT_RESULT" } }],
      },
    });
    const { text } = parseStreamJson(line);
    expect(text).toContain("OBJECT_RESULT");
    expect(text).not.toContain("[object Object]");
  });
});

// --- 3. unknown event -------------------------------------------------------

describe("ClaudeCodeAgentAdapter unknown stream-json event", () => {
  it("warns via the injected logger, does not throw, and still returns known content", async () => {
    const child = new FakeChild();
    withChild(child);
    const logger = spyLogger();

    const lines = [
      JSON.stringify({ type: "some_new_event", payload: { x: 1 } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "KNOWN_TEXT" }] },
      }),
    ].join("\n");

    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x", logger });
    const p = adapter.call(SIMPLE_INPUT);
    child.pushStdout(lines + "\n");
    child.close(0);
    const text = (await p) as string;

    expect(text).toContain("KNOWN_TEXT");
    expect(logger.warn).toHaveBeenCalled();
    const warnArgs = logger.warn.mock.calls.flat().join(" ");
    expect(warnArgs).toContain("some_new_event");
  });
});

// --- 4. CLI absent ----------------------------------------------------------

describe("ClaudeCodeAgentAdapter CLI absent", () => {
  it("rejects with a friendly message when spawn emits ENOENT", async () => {
    const child = new FakeChild();
    withChild(child);

    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      claudeBin: "claude-missing",
    });
    const p = adapter.call(SIMPLE_INPUT);
    child.fail("ENOENT");

    await expect(p).rejects.toThrow("Claude Code CLI not found");
    await expect(p).rejects.toThrow("claude-missing");
  });
});

// --- 5. timeout -------------------------------------------------------------

describe("ClaudeCodeAgentAdapter timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills the child and rejects with a timeout error when close never fires", async () => {
    const child = new FakeChild();
    withChild(child);

    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      timeout: 50,
    });
    const p = adapter.call(SIMPLE_INPUT);
    // Attach a rejection handler synchronously so the unhandled-rejection guard
    // does not fire while we advance timers.
    const assertion = expect(p).rejects.toThrow(/timed out after 50ms/);

    // Child never emits close → only the timeout timer can settle the promise.
    await vi.advanceTimersByTimeAsync(50);

    await assertion;
    expect(child.kill).toHaveBeenCalled();
  });
});

// --- 6. logger isolation ----------------------------------------------------

describe("ClaudeCodeAgentAdapter logger isolation", () => {
  it("routes diagnostics through the injected logger and never touches console", async () => {
    const child = new FakeChild();
    withChild(child);
    const logger = spyLogger();

    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/diag", logger });
      const p = adapter.call(SIMPLE_INPUT);
      child.pushStderr("some stderr noise");
      child.pushStdout(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        }) + "\n",
      );
      child.close(0);
      await p;

      // The injected logger saw the "Starting claude" line and the stderr line.
      const logged = logger.log.mock.calls.flat().join(" ");
      expect(logged).toContain("/tmp/diag");
      expect(logger.warn).toHaveBeenCalled();
      const warned = logger.warn.mock.calls.flat().join(" ");
      expect(warned).toContain("some stderr noise");

      // Console was never used by the adapter.
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
      consoleWarn.mockRestore();
      consoleError.mockRestore();
    }
  });
});

// --- 7. skill helpers -------------------------------------------------------

/** Build a minimal ScenarioExecutionStateLike exposing only `messages`. */
function stateWith(messages: ModelMessage[]): ScenarioExecutionStateLike {
  return { messages } as unknown as ScenarioExecutionStateLike;
}

describe("assertSkillWasRead", () => {
  it("passes when a message references the skill's SKILL.md", () => {
    const state = stateWith([
      { role: "assistant", content: "I read .skills/install-orchard/SKILL.md and will follow it." },
    ]);
    expect(() => assertSkillWasRead(state, "install-orchard")).not.toThrow();
  });

  it("passes when SKILL.md appears inside array/object content", () => {
    const state = stateWith([
      {
        role: "assistant",
        content: [
          { type: "tool_use", input: { path: ".skills/install-orchard/SKILL.md" } },
        ],
      } as unknown as ModelMessage,
    ]);
    expect(() => assertSkillWasRead(state, "install-orchard")).not.toThrow();
  });

  it("throws naming the skill when there is no read evidence", () => {
    const state = stateWith([
      { role: "assistant", content: "I just made something up without reading anything." },
    ]);
    expect(() => assertSkillWasRead(state, "install-orchard")).toThrow(
      /install-orchard/,
    );
  });
});

// --- env-gated integration --------------------------------------------------

describe.skipIf(!process.env.RUN_CLAUDE_CODE_E2E)(
  "ClaudeCodeAgentAdapter integration (RUN_CLAUDE_CODE_E2E=1)",
  () => {
    it("runs a real scenario with a real judge and returns a verdict", async () => {
      // Unmock spawn for the real run. MUST be `doUnmock` (runtime, NOT
      // hoisted): the top-level `vi.unmock` would be hoisted alongside
      // `vi.mock` and cancel the mock for the ENTIRE file. `doUnmock` only
      // affects modules imported AFTER this point, so we re-import the factory
      // (via the freshly-imported scenario barrel) to bind the real `spawn`.
      vi.doUnmock("node:child_process");
      vi.resetModules();
      const scenario = (await import("../../index.js")).default;

      // Use the OpenAI PROVIDER instance (not a bare "openai/..." string).
      // In the ai SDK v6 a string model resolves via the AI Gateway and
      // demands AI_GATEWAY_API_KEY; a provider instance authenticates directly
      // with OPENAI_API_KEY (the key this E2E is run with). `@ai-sdk/openai`
      // is already a dependency.
      const { openai } = await import("@ai-sdk/openai");
      const judgeModelId = process.env.SCENARIO_JUDGE_MODEL ?? "gpt-4.1-mini";

      const agent = scenario.claudeCodeAgent({
        workingDirectory: process.cwd(),
        skipPermissions: true,
        ...(process.env.CLAUDE_CODE_MODEL
          ? { model: process.env.CLAUDE_CODE_MODEL }
          : {}),
      });

      const result = await scenario.run({
        name: "claude-code-e2e",
        description: "User asks Claude Code a trivial factual question.",
        agents: [
          agent,
          scenario.userSimulatorAgent({ model: openai(judgeModelId) }),
          scenario.judgeAgent({
            model: openai(judgeModelId),
            criteria: ["The agent answers the user's question."],
          }),
        ],
        script: [
          scenario.user("what is 2 + 2? answer with just the number"),
          scenario.agent(),
          scenario.judge(),
        ],
      });

      expect(typeof result.success).toBe("boolean");
      expect(Array.isArray(result.messages)).toBe(true);
      // The agent under test produced at least one assistant turn.
      expect(
        result.messages.some((m) => m.role === "assistant"),
      ).toBe(true);
    }, 120000);
  },
);
