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
 * Coverage (each numbered group is a `describe` below):
 *  1.  argv: stream-json always; `--dangerously-skip-permissions` only when
 *      `skipPermissions:true`; `--model` only when `model` set; bin resolution.
 *  1b. session continuation: capture `session_id` on turn 1, `--resume` it on
 *      turn 2, send only the delta, keep threads distinct, reject an empty
 *      delta, fall back to full history when no id was captured, and — the new
 *      lifecycle rules — DON'T evict the session on a non-stale failure (signal,
 *      nonzero exit) or a timeout, so the next turn still resumes the same id.
 *      Also pins the PRIN-A invariant: a SUCCESSFUL resume spawns exactly once
 *      (the load-bearing `return` guard), never falling through to the rebuild.
 *  1c. stale-session recovery: a vanished `--resume` session rejects by default
 *      (error naming `replayOnLostSession`), and — only with
 *      `replayOnLostSession: true` — rebuilds in-turn from full history and
 *      resolves. Detection works structurally (the CLI's `result` envelope with
 *      empty stderr) AND via the stderr fallback. Includes a mocked
 *      `ScenarioExecution` regression (see note below) and turn-1 guard.
 *  1d. LostSessionError type contract: the default lost-session reject throws a
 *      `LostSessionError` (a `ClaudeCodeCliError` subclass) carrying the dead
 *      `sessionId`/`threadId` and the originating error as `cause`; replay-on
 *      never throws it (it recovers); a non-stale failure stays a bare
 *      `ClaudeCodeCliError`.
 *  2.  stream-json parsing preserves array-shaped `tool_result` content (never
 *      `[object Object]`); `session_id` capture from `system`/init and `result`
 *      lines (last one wins, absent when neither carries it). Pure
 *      `parseStreamJson`/one-clean-run unit tests — no rejection behavior is
 *      asserted here (see 5e for the `is_error:true` rejection coverage).
 *  3.  unknown event → `logger.warn` (deduped once per type), no throw, known
 *      content still returned; `stream_event` is known and never warns.
 *  4.  CLI-absent (spawn ENOENT) → reject with "Claude Code CLI not found".
 *  4b. empty messages (agent-first guard) → reject, never spawn.
 *  5.  timeout → reject with a timeout error AND `child.kill()` called; a resume
 *      turn's timeout does NOT evict the session. Plus timeout validation.
 *  5b. nonzero exit → reject with the exit code and captured stderr.
 *  5e. result-envelope failure: `is_error:true` on the terminal `result`
 *      envelope rejects even when the process exits 0 (never a silent
 *      empty-text success) and stores no session id, so the next turn on that
 *      thread spawns fresh (no `--resume`).
 *  5d. signal termination → reject with a signal error.
 *  6.  injected logger receives diagnostics; `console.*` is never used.
 *  7.  `assertSkillWasRead` passes on evidence, throws (naming the skill)
 *      without; scoping.
 *  8.  `claudeCodeAgent` factory injects a `skillPath` as a construction effect.
 *  9.  `safeStringify` never throws.
 *
 * CI note: the `RUN_CLAUDE_CODE_E2E=1` integration tests at the bottom are
 * DEV-ONLY smoke checks — they need a real `claude` binary (and, for two of
 * them, LLM keys) and run in no `.github/workflows/*.yml`. The CI-ENFORCED
 * regression protection for the stale-session fix is the MOCKED
 * `ScenarioExecution` test in group 1c ("a mid-run stale session does not abort
 * the scenario"); do not mistake the gated E2Es for enforced coverage.
 */

import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  AgentAdapter,
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  type ScenarioExecutionStateLike,
} from "../../domain/index.js";
import { ScenarioExecution } from "../../execution/scenario-execution.js";
import {
  agent as scriptAgent,
  succeed as scriptSucceed,
  user as scriptUser,
} from "../../script/index.js";
import {
  ClaudeCodeAgentAdapter,
  ClaudeCodeCliError,
  LostSessionError,
  claudeCodeAgent,
  parseStreamJson,
  assertSkillWasRead,
  type Logger,
} from "../claude-code/index.js";
import { safeStringify } from "../claude-code/stream-json.js";

/**
 * A USER-role agent so scripted `user("…")` steps resolve. Scripted steps carry
 * their own content, so `call` is never reached.
 */
class StubUserSim extends AgentAdapter {
  role = AgentRole.USER;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    throw new Error("StubUserSim.call should never run — steps carry content");
  }
}

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

  /**
   * Emit close with an exit code (default 0). Node passes `(code, signal)` with
   * a null signal on a normal exit — mirror that, or a `signal`-sensitive branch
   * in the adapter reads `undefined` here and `null` in production.
   */
  close(code = 0): void {
    this.emit("close", code, null);
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

/**
 * Install the spawn mock to return each child IN ORDER — the Nth spawn yields
 * `children[N]`. For turns that spawn more than once (a stale resume followed by
 * an in-turn rebuild), so each child can be hand-driven independently.
 */
function withChildren(children: FakeChild[]): void {
  for (const child of children) {
    spawnMock.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  }
}

/** One scripted CLI invocation for {@link scriptedSpawn}. */
interface ChildSpec {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

/**
 * Install a spawn mock that self-drives: the Nth spawn yields a child which
 * emits the Nth spec's output and closes on the next tick. Needed wherever the
 * adapter is driven by code we don't control (e.g. a real `ScenarioExecution`),
 * so there is no point at which the test can hand-feed each child.
 */
function scriptedSpawn(specs: ChildSpec[]): void {
  let index = 0;
  spawnMock.mockImplementation(() => {
    const spec = specs[index++] ?? {};
    const child = new FakeChild();
    // The adapter attaches its listeners synchronously in the promise executor
    // right after `spawn` returns, so deferring by one tick is enough.
    setImmediate(() => {
      if (spec.stdout) child.pushStdout(spec.stdout);
      if (spec.stderr) child.pushStderr(spec.stderr);
      child.emit("close", spec.code ?? 0, spec.signal ?? null);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

/** The argv (3rd positional) the adapter passed to spawn on the last call. */
function lastArgv(): string[] {
  const call = spawnMock.mock.calls.at(-1);
  return (call?.[1] as string[]) ?? [];
}

// --- input fixtures ---------------------------------------------------------

function makeInput(
  messages: ModelMessage[],
  opts: { threadId?: string; newMessages?: ModelMessage[] } = {},
): AgentInput {
  return {
    threadId: opts.threadId ?? "claude-code-thread",
    messages,
    // Default `newMessages` to the full history, matching the framework's
    // first-turn shape (whole transcript is "new"). Tests that exercise a
    // resume turn pass a narrower `newMessages` delta explicitly.
    newMessages: opts.newMessages ?? messages,
    requestedRole: AgentRole.AGENT,
    scenarioState: {} as unknown as AgentInput["scenarioState"],
    scenarioConfig: {
      name: "claude-code",
      description: "A test.",
    } as unknown as AgentInput["scenarioConfig"],
  } as AgentInput;
}

const SIMPLE_INPUT = makeInput([{ role: "user", content: "hello" }]);

/** A stream-json `system`/init line carrying a top-level `session_id`. */
function systemInitLine(sessionId: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sessionId,
  });
}

/** A normal assistant text line. */
function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/**
 * The CLI's terminal `type: "result"` envelope. Only the provided fields are
 * emitted, mirroring the real wire object. Used to exercise the structural
 * failure/stale-session signal the adapter reads off stdout.
 */
function resultLine(fields: {
  isError?: boolean;
  subtype?: string;
  errors?: string[];
  sessionId?: string;
}): string {
  return JSON.stringify({
    type: "result",
    ...(fields.subtype !== undefined ? { subtype: fields.subtype } : {}),
    ...(fields.isError !== undefined ? { is_error: fields.isError } : {}),
    ...(fields.errors !== undefined ? { errors: fields.errors } : {}),
    ...(fields.sessionId !== undefined ? { session_id: fields.sessionId } : {}),
  });
}

/** The prompt positional arg (last argv entry) the adapter passed to spawn on the last call. */
function lastPrompt(): string {
  return lastArgv().at(-1) ?? "";
}

/** The argv of the Nth spawn call (0-indexed). */
function argvAt(index: number): string[] {
  return (spawnMock.mock.calls[index]?.[1] as string[]) ?? [];
}

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

// --- 1b. session continuation -----------------------------------------------

describe("ClaudeCodeAgentAdapter session continuation", () => {
  it("captures session_id on the first turn and resumes it on the next turn for the same threadId", async () => {
    // The adapter instance is reused across turns; it must thread the session.
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Turn 1: a system/init line carries session_id "sess-abc". No --resume.
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "remember PINEAPPLE42" }]),
    );
    child1.pushStdout(
      systemInitLine("sess-abc") + "\n" + assistantLine("noted") + "\n",
    );
    child1.close(0);
    await turn1;

    expect(argvAt(0)).not.toContain("--resume");

    // Turn 2: same threadId → must spawn with `--resume sess-abc`.
    const child2 = new FakeChild();
    withChild(child2);
    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "remember PINEAPPLE42" },
          { role: "assistant", content: "noted" },
          { role: "user", content: "what was the secret word?" },
        ],
        { newMessages: [{ role: "user", content: "what was the secret word?" }] },
      ),
    );
    child2.pushStdout(assistantLine("PINEAPPLE42") + "\n");
    child2.close(0);
    await turn2;

    const argv2 = argvAt(1);
    const resumeIdx = argv2.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(argv2[resumeIdx + 1]).toBe("sess-abc");
  });

  it("sends only the new-message delta (not the full transcript) on a resume turn", async () => {
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Turn 1 establishes the session.
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }]),
    );
    child1.pushStdout(
      systemInitLine("sess-delta") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    // Turn 2: full history includes earlier turns, but newMessages is just the
    // latest user message. The prompt positional must contain ONLY the delta.
    const child2 = new FakeChild();
    withChild(child2);
    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );
    child2.pushStdout(assistantLine("done") + "\n");
    child2.close(0);
    await turn2;

    const prompt = lastPrompt();
    expect(prompt).toContain("SECOND_TURN_DELTA");
    expect(prompt).not.toContain("FIRST_TURN_TEXT");
  });

  it("keeps sessions distinct per threadId — neither thread resumes the other's session", async () => {
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Thread A, turn 1.
    const childA = new FakeChild();
    withChild(childA);
    const a1 = adapter.call(
      makeInput([{ role: "user", content: "hi from A" }], { threadId: "thread-A" }),
    );
    childA.pushStdout(
      systemInitLine("sess-A") + "\n" + assistantLine("hello A") + "\n",
    );
    childA.close(0);
    await a1;

    // Thread B, turn 1 — must start fresh (no --resume at all).
    const childB = new FakeChild();
    withChild(childB);
    const b1 = adapter.call(
      makeInput([{ role: "user", content: "hi from B" }], { threadId: "thread-B" }),
    );
    childB.pushStdout(
      systemInitLine("sess-B") + "\n" + assistantLine("hello B") + "\n",
    );
    childB.close(0);
    await b1;

    expect(argvAt(1)).not.toContain("--resume");

    // Thread B, turn 2 — must resume sess-B, NOT sess-A.
    const childB2 = new FakeChild();
    withChild(childB2);
    const b2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "hi from B" },
          { role: "assistant", content: "hello B" },
          { role: "user", content: "follow-up B" },
        ],
        { threadId: "thread-B", newMessages: [{ role: "user", content: "follow-up B" }] },
      ),
    );
    childB2.pushStdout(assistantLine("answer B") + "\n");
    childB2.close(0);
    await b2;

    const argvB2 = argvAt(2);
    const resumeIdx = argvB2.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(argvB2[resumeIdx + 1]).toBe("sess-B");
    expect(argvB2).not.toContain("sess-A");
  });

  it("rejects a resume turn with an empty delta (no newMessages) instead of spawning claude -p --resume \"\"", async () => {
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Turn 1 establishes the session.
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "opener" }]),
    );
    child1.pushStdout(
      systemInitLine("sess-empty") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    const spawnsBefore = spawnMock.mock.calls.length;

    // Turn 2 on the same thread but with an empty delta → loud reject, no spawn.
    await expect(
      adapter.call(
        makeInput(
          [
            { role: "user", content: "opener" },
            { role: "assistant", content: "ok" },
          ],
          { newMessages: [] },
        ),
      ),
    ).rejects.toThrow(/received no messages to send to the CLI/);

    // The agent-first/no-delta guard short-circuits before spawning.
    expect(spawnMock.mock.calls.length).toBe(spawnsBefore);

    // …and, crucially, that client-side guard must NOT evict the session: the
    // CLI was never contacted, so the server session is untouched. Turn 3 (with
    // a real delta) must therefore still resume sess-empty.
    const child3 = new FakeChild();
    withChild(child3);
    const turn3 = adapter.call(
      makeInput(
        [
          { role: "user", content: "opener" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "real follow-up" },
        ],
        { newMessages: [{ role: "user", content: "real follow-up" }] },
      ),
    );
    child3.pushStdout(assistantLine("answered") + "\n");
    child3.close(0);
    await turn3;

    const argv3 = lastArgv();
    expect(argv3).toContain("--resume");
    expect(argv3[argv3.indexOf("--resume") + 1]).toBe("sess-empty");
  });

  it("falls back to full history (no --resume) when the first turn captured no session_id", async () => {
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Turn 1: ONLY an assistant line — no system/init line, so nothing stamps a
    // session_id. The adapter must store nothing for this thread.
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }]),
    );
    child1.pushStdout(assistantLine("ok") + "\n");
    child1.close(0);
    await turn1;

    expect(argvAt(0)).not.toContain("--resume");

    // Turn 2: same threadId, narrow newMessages delta. With no captured id the
    // adapter is NOT in continuation mode, so it must spawn WITHOUT --resume and
    // send the FULL history (nothing was captured to resume against).
    const child2 = new FakeChild();
    withChild(child2);
    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );
    child2.pushStdout(assistantLine("done") + "\n");
    child2.close(0);
    await turn2;

    expect(argvAt(1)).not.toContain("--resume");
    const prompt = lastPrompt();
    expect(prompt).toContain("FIRST_TURN_TEXT");
    expect(prompt).toContain("SECOND_TURN_DELTA");
  });

  it("keeps the session cached when a resume turn fails for a non-recoverable reason (no evict, no retry)", async () => {
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Turn 1 establishes session "sess-heal".
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }]),
    );
    child1.pushStdout(
      systemInitLine("sess-heal") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    // Turn 2: a resume turn (delta only) whose CLI exits NON-ZERO for a reason
    // that is NOT a stale session (auth/rate-limit). It must surface the real
    // stderr and must NOT silently retry.
    const child2 = new FakeChild();
    withChild(child2);
    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );
    child2.pushStderr("Rate limit exceeded");
    child2.close(1);
    await expect(turn2).rejects.toThrow(/exit code 1: Rate limit exceeded/);

    // The failed resume DID pass --resume sess-heal (it was a continuation turn),
    // and it spawned exactly once — no hidden retry on a non-stale failure.
    const argv2 = argvAt(1);
    expect(argv2).toContain("--resume");
    expect(argv2[argv2.indexOf("--resume") + 1]).toBe("sess-heal");
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Turn 3: same threadId. A non-stale failure must NOT evict the session —
    // the server session may still be valid — so the adapter is STILL in
    // continuation mode and must resume the SAME id (sess-heal), sending only
    // the delta.
    const child3 = new FakeChild();
    withChild(child3);
    const turn3 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
          { role: "assistant", content: "(failed)" },
          { role: "user", content: "THIRD_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "THIRD_TURN_DELTA" }] },
      ),
    );
    child3.pushStdout(assistantLine("recovered") + "\n");
    child3.close(0);
    await turn3;

    const argv3 = argvAt(2);
    expect(argv3).toContain("--resume");
    expect(argv3[argv3.indexOf("--resume") + 1]).toBe("sess-heal");
    const prompt3 = lastPrompt();
    expect(prompt3).toContain("THIRD_TURN_DELTA");
    expect(prompt3).not.toContain("FIRST_TURN_TEXT");
  });

  it("keeps the session cached when a resume turn is terminated by a signal (no evict, no retry)", async () => {
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Turn 1 establishes session "sess-sig".
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }]),
    );
    child1.pushStdout(
      systemInitLine("sess-sig") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    // Turn 2: a resume turn (delta only) whose CLI is terminated by a signal.
    // A signal death is NOT a stale session — it must reject with a signal error
    // and must NOT retry.
    const child2 = new FakeChild();
    withChild(child2);
    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );

    // Verify the resume turn DID pass --resume sess-sig before it was killed.
    const argv2 = argvAt(1);
    expect(argv2).toContain("--resume");
    expect(argv2[argv2.indexOf("--resume") + 1]).toBe("sess-sig");

    child2.emit("close", null, "SIGKILL");
    await expect(turn2).rejects.toThrow(/terminated by signal SIGKILL/);
    // Exactly one spawn for turn 2 — no hidden retry on a signal death.
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Turn 3: same threadId. A signal death must NOT evict the session, so the
    // adapter is STILL in continuation mode — it must resume the SAME id
    // (sess-sig), sending only the delta.
    const child3 = new FakeChild();
    withChild(child3);
    const turn3 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
          { role: "assistant", content: "(failed)" },
          { role: "user", content: "THIRD_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "THIRD_TURN_DELTA" }] },
      ),
    );
    child3.pushStdout(assistantLine("recovered") + "\n");
    child3.close(0);
    await turn3;

    const argv3 = argvAt(2);
    expect(argv3).toContain("--resume");
    expect(argv3[argv3.indexOf("--resume") + 1]).toBe("sess-sig");
    const prompt3 = lastPrompt();
    expect(prompt3).toContain("THIRD_TURN_DELTA");
    expect(prompt3).not.toContain("FIRST_TURN_TEXT");
  });

  // PRIN-A fall-through guard. `call()`'s catch falls through onto the shared
  // full-history rebuild only for an opted-in stale session; the SUCCESS path's
  // load-bearing `return text` is the ONLY thing stopping a successful resume
  // from ALSO running that rebuild. This pins the invariant: a successful resume
  // spawns exactly ONCE and returns the resumed text from the delta alone. It
  // goes red the moment a future editor drops that `return`. scriptedSpawn
  // self-drives every spawn (incl. a would-be third one), so a regression fails
  // on the assertions below rather than hanging on an undriven rebuild child.
  it("a successful resume turn spawns exactly once (no fall-through to the rebuild) and returns the resumed text from the delta only", async () => {
    scriptedSpawn([
      // Turn 1: mints session "sess-once".
      { stdout: systemInitLine("sess-once") + "\n" + assistantLine("ok") + "\n" },
      // Turn 2: --resume sess-once SUCCEEDS with the resumed answer.
      { stdout: assistantLine("RESUMED_ANSWER") + "\n" },
      // A third spawn must never happen on a successful resume; if the
      // load-bearing `return` is dropped this self-closes and the count/text
      // assertions below go red (instead of the test hanging).
      { stdout: assistantLine("REBUILD_SHOULD_NOT_RUN") + "\n" },
    ]);

    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Turn 1 establishes the session.
    await adapter.call(makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }]));

    // Turn 2 resumes and succeeds.
    const turn2Text = await adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );

    // Resolves with the resumed text — NOT the rebuild's text.
    expect(turn2Text).toContain("RESUMED_ANSWER");
    expect(turn2Text).not.toContain("REBUILD_SHOULD_NOT_RUN");

    // Exactly one spawn for turn 2 (two total): a successful resume must not fall
    // through to the rebuild.
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Turn 2 resumed the session and sent ONLY the delta, never the full history.
    const argv2 = argvAt(1);
    expect(argv2).toContain("--resume");
    expect(argv2[argv2.indexOf("--resume") + 1]).toBe("sess-once");
    const turn2Prompt = argv2.at(-1) ?? "";
    expect(turn2Prompt).toContain("SECOND_TURN_DELTA");
    expect(turn2Prompt).not.toContain("FIRST_TURN_TEXT");
  });
});

// --- 1c. stale-session recovery ---------------------------------------------
//
// A vanished server-side session must be recovered from WITHIN the same turn.
// Rejecting and deferring the rebuild to "the next turn" is not a recovery:
// `ScenarioExecution.callAgent` rethrows anything an adapter's `call()` throws
// (`scenario-execution.ts`, `catch (error) { throw new Error(...) }`), which
// aborts the whole run — so there is no next turn to rebuild on.

describe("ClaudeCodeAgentAdapter stale-session recovery", () => {
  it("with replayOnLostSession, recovers in-turn via the STDERR FALLBACK when the resumed session is gone: replays full history and resolves", async () => {
    // Opt in to replay; the default (covered separately) is to reject.
    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      replayOnLostSession: true,
    });

    // Turn 1 establishes session "sess-gone".
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }]),
    );
    child1.pushStdout(
      systemInitLine("sess-gone") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    // Turn 2 resumes, but the CLI reports the session no longer exists — here
    // via STDERR ONLY, with no `result` envelope on stdout (an older CLI, or a
    // crash before the envelope). This exercises the stderr FALLBACK branch of
    // stale detection. With replay opted in, the turn must NOT reject — it must
    // transparently rebuild and resolve.
    const staleChild = new FakeChild();
    const rebuildChild = new FakeChild();
    withChildren([staleChild, rebuildChild]);

    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );

    // The stale resume fails via stderr only (no stdout envelope)…
    // `runTurn()` spawns synchronously inside its `new Promise` executor
    // (before `call()`'s first `await` suspends), so this is already true the
    // instant `adapter.call()` above returns — no need to poll for it.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    staleChild.pushStderr(
      "No conversation found with session ID: sess-gone\n",
    );
    staleChild.close(1);

    // …and the adapter immediately respawns without --resume, replaying history.
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3));
    rebuildChild.pushStdout(
      systemInitLine("sess-fresh") + "\n" + assistantLine("recovered") + "\n",
    );
    rebuildChild.close(0);

    await expect(turn2).resolves.toContain("recovered");

    // The failed attempt did resume; the rebuild did not.
    expect(argvAt(1)).toContain("--resume");
    expect(argvAt(2)).not.toContain("--resume");

    // The rebuild replayed the FULL history, not just the delta — otherwise the
    // fresh session would have lost every prior turn.
    const rebuildPrompt = argvAt(2).at(-1) ?? "";
    expect(rebuildPrompt).toContain("FIRST_TURN_TEXT");
    expect(rebuildPrompt).toContain("SECOND_TURN_DELTA");
  });

  it("by default (replayOnLostSession unset) REJECTS a lost session with an error naming the flag — exactly one spawn, no rebuild", async () => {
    // No replayOnLostSession → the default fail-loudly policy.
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Turn 1 establishes session "sess-gone".
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }]),
    );
    child1.pushStdout(
      systemInitLine("sess-gone") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    const spawnsBefore = spawnMock.mock.calls.length;

    // Turn 2 resumes a vanished session. With replay OFF the turn must reject —
    // and the error must name the flag AND state what replay would cost, so an
    // operator can make an informed choice rather than get a silent downgrade.
    // A queued (not persistent) mock: if the default ever silently flipped to
    // `true`, the code would attempt a rebuild spawn, and this ensures that
    // spawn gets `undefined` rather than the SAME already-closed `staleChild`
    // (whose `close` listener would never re-fire) — a fast assertion failure
    // instead of a ~20s suite-timeout hang. See sibling tests in this describe
    // block, which use `withChildren` for the same reason.
    const staleChild = new FakeChild();
    withChildren([staleChild]);
    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );
    staleChild.pushStderr("No conversation found with session ID: sess-gone");
    staleChild.close(1);

    // Flag-name assertion plus one substantive assertion. Deliberately not
    // pinning the exact fidelity-tradeoff wording (e.g. "loses server-side
    // session state") — a harmless reword of that sentence shouldn't break
    // this test when the contract itself is unchanged.
    await expect(turn2).rejects.toThrow(/replayOnLostSession: true/);
    await expect(turn2).rejects.toThrow(/no longer exists/);

    // Exactly ONE spawn for the lost-session turn — the default path never
    // rebuilds.
    expect(spawnMock.mock.calls.length).toBe(spawnsBefore + 1);
  });

  it("with replayOnLostSession, detects a lost session STRUCTURALLY from the result envelope even when stderr is empty", async () => {
    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      replayOnLostSession: true,
    });

    // Turn 1 establishes session "sess-gone".
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }]),
    );
    child1.pushStdout(
      systemInitLine("sess-gone") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    // Turn 2 resumes. The CLI signals the stale session STRUCTURALLY: its
    // terminal `result` envelope carries subtype "error_during_execution" and a
    // "No conversation found" error — with NOTHING on stderr. The stderr
    // fallback regex would miss this; only the structural check catches it.
    const staleChild = new FakeChild();
    const rebuildChild = new FakeChild();
    withChildren([staleChild, rebuildChild]);

    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );

    // `runTurn()` spawns synchronously inside its `new Promise` executor
    // (before `call()`'s first `await` suspends), so this is already true the
    // instant `adapter.call()` above returns — no need to poll for it.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    // Structural signal on STDOUT, empty stderr, exit 1.
    staleChild.pushStdout(
      resultLine({
        isError: true,
        subtype: "error_during_execution",
        errors: ["No conversation found with session ID: sess-gone"],
      }) + "\n",
    );
    staleChild.close(1);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3));
    rebuildChild.pushStdout(
      systemInitLine("sess-fresh") + "\n" + assistantLine("recovered") + "\n",
    );
    rebuildChild.close(0);

    await expect(turn2).resolves.toContain("recovered");
    expect(argvAt(1)).toContain("--resume");
    expect(argvAt(2)).not.toContain("--resume");
  });

  it("resumes the freshly-minted session on the turn after a recovery", async () => {
    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      replayOnLostSession: true,
    });

    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(makeInput([{ role: "user", content: "one" }]));
    child1.pushStdout(systemInitLine("sess-gone") + "\n" + assistantLine("ok") + "\n");
    child1.close(0);
    await turn1;

    const staleChild = new FakeChild();
    const rebuildChild = new FakeChild();
    withChildren([staleChild, rebuildChild]);

    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "one" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "two" },
        ],
        { newMessages: [{ role: "user", content: "two" }] },
      ),
    );
    // `runTurn()` spawns synchronously inside its `new Promise` executor
    // (before `call()`'s first `await` suspends), so this is already true the
    // instant `adapter.call()` above returns — no need to poll for it.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    staleChild.pushStderr("No conversation found with session ID: sess-gone");
    staleChild.close(1);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3));
    rebuildChild.pushStdout(
      systemInitLine("sess-fresh") + "\n" + assistantLine("recovered") + "\n",
    );
    rebuildChild.close(0);
    await turn2;

    // Turn 3 must resume the id minted by the REBUILD, not the dead one.
    const child3 = new FakeChild();
    withChild(child3);
    const turn3 = adapter.call(
      makeInput(
        [
          { role: "user", content: "one" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "two" },
          { role: "assistant", content: "recovered" },
          { role: "user", content: "three" },
        ],
        { newMessages: [{ role: "user", content: "three" }] },
      ),
    );
    child3.pushStdout(assistantLine("ok3") + "\n");
    child3.close(0);
    await turn3;

    const argv3 = argvAt(3);
    expect(argv3[argv3.indexOf("--resume") + 1]).toBe("sess-fresh");
  });

  // The rebuild itself can also fail. `call()`'s rebuild spawn (the
  // full-history retry after evicting a dead session) sits OUTSIDE any
  // try/catch — see the "First turn for this thread, or the opt-in rebuild…"
  // comment in adapter.ts — so if IT throws too, that failure must propagate
  // raw, and the (already-deleted) session entry must stay gone.
  it("with replayOnLostSession, when the REBUILD ITSELF fails, rejects with the rebuild's own error — a bare ClaudeCodeCliError, not a LostSessionError — and turn 3 starts fresh", async () => {
    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      replayOnLostSession: true,
    });

    // Turn 1 establishes session "sess-gone".
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }]),
    );
    child1.pushStdout(
      systemInitLine("sess-gone") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    // Turn 2 resumes; the session is gone (stderr fallback), so replay kicks
    // in and the adapter respawns WITHOUT --resume — but the rebuild child
    // ITSELF fails, for an unrelated, distinct reason (a rate limit). This
    // failure must surface AS-IS, never reinterpreted as another lost session.
    const staleChild = new FakeChild();
    const rebuildChild = new FakeChild();
    withChildren([staleChild, rebuildChild]);

    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );
    // Already true the instant `adapter.call()` above returns — see the
    // sibling tests' note on `runTurn()`'s synchronous spawn.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    staleChild.pushStderr("No conversation found with session ID: sess-gone");
    staleChild.close(1);

    // …the adapter respawns for the rebuild — and THIS spawn also fails.
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3));
    rebuildChild.pushStderr("Rate limit exceeded");
    rebuildChild.close(1);

    let caught: unknown;
    try {
      await turn2;
    } catch (err) {
      caught = err;
    }

    // The rebuild's OWN error surfaces — not the stale-session error — and it
    // is a bare ClaudeCodeCliError, never a LostSessionError (the rebuild
    // failure is not itself a lost session).
    expect(caught).toBeInstanceOf(ClaudeCodeCliError);
    expect(caught).not.toBeInstanceOf(LostSessionError);
    const err = caught as ClaudeCodeCliError;
    expect(err.message).toMatch(/Rate limit exceeded/);
    expect(err.message).not.toMatch(/No conversation found/);

    // The thread's session entry stayed deleted (the failed rebuild never
    // reached the success path that stores a fresh id): turn 3 must spawn
    // fresh — no phantom --resume — and carry the FULL history again, not a
    // bare delta.
    const child3 = new FakeChild();
    withChild(child3);
    const turn3 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );
    child3.pushStdout(assistantLine("third try ok") + "\n");
    child3.close(0);
    await turn3;

    const argv3 = argvAt(3);
    expect(argv3).not.toContain("--resume");
    const turn3Prompt = argv3.at(-1) ?? "";
    expect(turn3Prompt).toContain("FIRST_TURN_TEXT");
    expect(turn3Prompt).toContain("SECOND_TURN_DELTA");
  });

  // Turn-1 guard: recovery is keyed off a STORED session id, never off stderr
  // content. A first turn has no stored id (`resumeSessionId` is undefined), so
  // even a "No conversation found" stderr must NOT trigger any recovery — it
  // surfaces as a normal CLI failure. This guards against a future refactor
  // keying recovery off the stderr sentence instead of `resumeSessionId`, which
  // would spuriously "recover" a genuine first-turn failure. (It is NOT a test
  // of the recovery behaviour itself — group's other tests cover that.)
  it("a first turn never attempts recovery — no stored session id, so a No-conversation stderr just surfaces", async () => {
    // replayOnLostSession is irrelevant here (left default): recovery is gated
    // on a stored id first, and a first turn has none.
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });
    const child = new FakeChild();
    withChild(child);

    const turn1 = adapter.call(SIMPLE_INPUT);
    child.pushStderr("No conversation found with session ID: whatever");
    child.close(1);

    await expect(turn1).rejects.toThrow(/exit code 1/);
    // Exactly one spawn: a first turn has nothing to rebuild from.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  // The regression that matters: drive a REAL ScenarioExecution (no CLI, no
  // network) whose second turn hits a vanished session. Before in-turn
  // recovery, `call()` rejected here and the executor's `catch { throw }`
  // aborted the run — the "rebuild on the next turn" could never happen.
  it("a mid-run stale session does not abort the scenario", async () => {
    scriptedSpawn([
      // Turn 1: mints session s1.
      { stdout: systemInitLine("s1") + "\n" + assistantLine("ack") + "\n" },
      // Turn 2: --resume s1 → the session is gone.
      { stderr: "No conversation found with session ID: s1", code: 1 },
      // Turn 2, rebuilt: fresh session, full history replayed.
      {
        stdout:
          systemInitLine("s2") + "\n" + assistantLine("recovered answer") + "\n",
      },
    ]);

    const exec = new ScenarioExecution(
      {
        name: "claude-code stale session",
        description: "turn 2 resumes a session the CLI no longer has",
        agents: [
          // Opt in to replay so the run SURVIVES the vanished session — that is
          // the regression this CI-enforced test protects.
          new ClaudeCodeAgentAdapter({
            workingDirectory: "/tmp/x",
            replayOnLostSession: true,
          }),
          new StubUserSim(),
        ],
      },
      [
        scriptUser("first user turn"),
        scriptAgent(),
        scriptUser("second user turn"),
        scriptAgent(),
        scriptSucceed("reached the end"),
      ],
      "test-batch-id",
    );

    const result = await exec.execute();

    expect(result.success).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(argvAt(1)).toContain("--resume");
    expect(argvAt(2)).not.toContain("--resume");

    // The scenario got a real turn-2 answer, not a dead run.
    const assistantText = result.messages
      .filter((m) => m.role === "assistant")
      .map((m) =>
        typeof m.content === "string" ? m.content : safeStringify(m.content),
      )
      .join("\n");
    expect(assistantText).toContain("recovered answer");
  });
});

// --- 1d. LostSessionError type contract -------------------------------------
//
// The default lost-session path must surface a TYPED error, not a plain one:
// `LostSessionError extends ClaudeCodeCliError`, so a caller doing
// `catch (e) { if (e instanceof ClaudeCodeCliError) … }` still catches it, while
// `instanceof LostSessionError` distinguishes the vanished session — the failure
// a caller most needs to branch on — from a genuine CLI failure.

describe("ClaudeCodeAgentAdapter LostSessionError", () => {
  it("throws a LostSessionError (also a ClaudeCodeCliError) carrying the dead session id, thread, and cause when replay is off", async () => {
    // Default policy (replayOnLostSession unset): a lost session is THROWN, not
    // rebuilt — and the thrown error must be the typed LostSessionError.
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Turn 1 establishes session "sess-vanished" on thread "thread-lost".
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }], {
        threadId: "thread-lost",
      }),
    );
    child1.pushStdout(
      systemInitLine("sess-vanished") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    // Turn 2 resumes the now-vanished session.
    const staleChild = new FakeChild();
    withChild(staleChild);
    let caught: unknown;
    try {
      const turn2 = adapter.call(
        makeInput(
          [
            { role: "user", content: "FIRST_TURN_TEXT" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "SECOND_TURN_DELTA" },
          ],
          {
            threadId: "thread-lost",
            newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }],
          },
        ),
      );
      staleChild.pushStderr(
        "No conversation found with session ID: sess-vanished",
      );
      staleChild.close(1);
      await turn2;
    } catch (err) {
      caught = err;
    }

    // Subclass identity: BOTH instanceofs hold; only LostSessionError singles it out.
    expect(caught).toBeInstanceOf(LostSessionError);
    expect(caught).toBeInstanceOf(ClaudeCodeCliError);
    const lost = caught as LostSessionError;
    expect(lost.name).toBe("LostSessionError");
    // Typed fields naming the dead session.
    expect(lost.sessionId).toBe("sess-vanished");
    expect(lost.threadId).toBe("thread-lost");
    // The originating CLI failure is preserved as `cause` — itself a plain
    // ClaudeCodeCliError, NOT a LostSessionError.
    expect(lost.cause).toBeInstanceOf(ClaudeCodeCliError);
    expect(lost.cause).not.toBeInstanceOf(LostSessionError);
    // The actionable message is retained verbatim.
    expect(lost.message).toMatch(/replayOnLostSession: true/);
    expect(lost.message).toMatch(/no longer exists/);
  });

  it("with replayOnLostSession: true, never throws a LostSessionError — it recovers in place and resolves", async () => {
    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      replayOnLostSession: true,
    });

    // Turn 1 establishes session "sess-vanished".
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(
      makeInput([{ role: "user", content: "FIRST_TURN_TEXT" }]),
    );
    child1.pushStdout(
      systemInitLine("sess-vanished") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    // Turn 2 resumes the vanished session; replay is opted in, so it recovers.
    const staleChild = new FakeChild();
    const rebuildChild = new FakeChild();
    withChildren([staleChild, rebuildChild]);
    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "FIRST_TURN_TEXT" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "SECOND_TURN_DELTA" },
        ],
        { newMessages: [{ role: "user", content: "SECOND_TURN_DELTA" }] },
      ),
    );
    // `runTurn()` spawns synchronously inside its `new Promise` executor
    // (before `call()`'s first `await` suspends), so this is already true the
    // instant `adapter.call()` above returns — no need to poll for it.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    staleChild.pushStderr(
      "No conversation found with session ID: sess-vanished",
    );
    staleChild.close(1);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3));
    rebuildChild.pushStdout(
      systemInitLine("sess-fresh") + "\n" + assistantLine("recovered") + "\n",
    );
    rebuildChild.close(0);

    // No LostSessionError thrown: the turn recovers and resolves with the
    // rebuilt answer.
    await expect(turn2).resolves.toContain("recovered");
  });

  it("a non-stale resume failure rejects with a bare ClaudeCodeCliError, never a LostSessionError", async () => {
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // Turn 1 establishes a live session.
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(makeInput([{ role: "user", content: "one" }]));
    child1.pushStdout(
      systemInitLine("sess-live") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    // Turn 2 resumes but fails for a NON-stale reason (rate limit). The original
    // CLI failure must surface AS-IS, never reclassified as a lost session.
    const child2 = new FakeChild();
    withChild(child2);
    let caught: unknown;
    try {
      const turn2 = adapter.call(
        makeInput(
          [
            { role: "user", content: "one" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "two" },
          ],
          { newMessages: [{ role: "user", content: "two" }] },
        ),
      );
      child2.pushStderr("Rate limit exceeded");
      child2.close(1);
      await turn2;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ClaudeCodeCliError);
    expect(caught).not.toBeInstanceOf(LostSessionError);
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

  it("parseStreamJson surfaces the top-level session_id from a system/init line", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-xyz" }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    ].join("\n");
    const { sessionId, text } = parseStreamJson(stdout);
    expect(sessionId).toBe("sess-xyz");
    expect(text).toContain("hi");
  });

  it("parseStreamJson returns the last session_id when more than one line carries it", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-old" }),
      JSON.stringify({ type: "result", session_id: "sess-new" }),
    ].join("\n");
    expect(parseStreamJson(stdout).sessionId).toBe("sess-new");
  });

  it("parseStreamJson leaves sessionId undefined when no line carries one", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(parseStreamJson(line).sessionId).toBeUndefined();
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

  it("treats stream_event as known (never warns) and warns at most once per unknown type", () => {
    const logger = spyLogger();
    // stream_event is the per-token delta stream under
    // --include-partial-messages (dozens per reply); mystery_event stands in for
    // a genuinely novel type, repeated to prove the per-call dedupe.
    const stdout = [
      JSON.stringify({ type: "stream_event", event: { delta: "a" } }),
      JSON.stringify({ type: "stream_event", event: { delta: "b" } }),
      JSON.stringify({ type: "mystery_event", n: 1 }),
      JSON.stringify({ type: "mystery_event", n: 2 }),
      JSON.stringify({ type: "mystery_event", n: 3 }),
      assistantLine("hi"),
    ].join("\n");

    const { text } = parseStreamJson(stdout, logger);
    expect(text).toContain("hi");

    const allWarnings = logger.warn.mock.calls.map((c) => c.join(" "));
    // stream_event is allowlisted → never warns, even seen twice.
    expect(allWarnings.some((w) => w.includes("stream_event"))).toBe(false);
    // mystery_event is unknown, seen 3× → warns EXACTLY once (deduped per call).
    expect(allWarnings.filter((w) => w.includes("mystery_event"))).toHaveLength(1);
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

// --- 4b. empty messages (agent-first guard) ---------------------------------

describe("ClaudeCodeAgentAdapter empty messages", () => {
  it("rejects with a descriptive error and never spawns when there are no messages", async () => {
    const child = new FakeChild();
    withChild(child);

    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    await expect(adapter.call(makeInput([]))).rejects.toThrow(
      /received no messages to send to the CLI/,
    );
    // The agent-first guard short-circuits before spawning anything.
    expect(spawnMock).not.toHaveBeenCalled();
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

// --- 5a. resume-turn timeout does not evict ---------------------------------

describe("ClaudeCodeAgentAdapter resume-turn timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects, does NOT rebuild, and does NOT evict the session (the next turn resumes the same id)", async () => {
    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      timeout: 50,
    });

    // Turn 1 establishes session "sess-timeout".
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(makeInput([{ role: "user", content: "one" }]));
    child1.pushStdout(
      systemInitLine("sess-timeout") + "\n" + assistantLine("ok") + "\n",
    );
    child1.close(0);
    await turn1;

    // Turn 2 resumes, then the CLI hangs → the per-call timeout fires. A timeout
    // is NOT a stale session: the turn must reject, must not rebuild in-turn, and
    // must leave the session cached (it may well still be valid server-side).
    const child2 = new FakeChild();
    withChild(child2);
    const turn2 = adapter.call(
      makeInput(
        [
          { role: "user", content: "one" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "two" },
        ],
        { newMessages: [{ role: "user", content: "two" }] },
      ),
    );
    // Attach the rejection handler before advancing so the reject is handled.
    const assertion = expect(turn2).rejects.toThrow(/timed out after 50ms/);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;

    // Exactly two spawns — the timeout did NOT trigger an in-turn rebuild.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(child2.kill).toHaveBeenCalled();

    // Turn 3: the session was NOT evicted → it must still resume sess-timeout.
    const child3 = new FakeChild();
    withChild(child3);
    const turn3 = adapter.call(
      makeInput(
        [
          { role: "user", content: "one" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "two" },
          { role: "assistant", content: "(timed out)" },
          { role: "user", content: "three" },
        ],
        { newMessages: [{ role: "user", content: "three" }] },
      ),
    );
    child3.pushStdout(assistantLine("ok3") + "\n");
    child3.close(0);
    await turn3;

    const argv3 = argvAt(2);
    expect(argv3).toContain("--resume");
    expect(argv3[argv3.indexOf("--resume") + 1]).toBe("sess-timeout");
  });
});

// --- 5b. nonzero exit code --------------------------------------------------

describe("ClaudeCodeAgentAdapter nonzero exit", () => {
  it("rejects with the exit code and the captured stderr when close fires nonzero", async () => {
    const child = new FakeChild();
    withChild(child);

    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });
    const p = adapter.call(SIMPLE_INPUT);
    child.pushStderr("Invalid API key (rate limit / auth)");
    child.close(1);

    await expect(p).rejects.toThrow(/exit code 1/);
    await expect(p).rejects.toThrow(/Invalid API key/);
  });
});

// --- 5e. result-envelope failure detection ----------------------------------

describe("ClaudeCodeAgentAdapter result-envelope failure", () => {
  it("rejects a run that fields is_error:true even on a 0 exit — no silent empty success, no session stored", async () => {
    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });

    // A first turn whose CLI exits 0 but fields is_error:true on its result
    // envelope (a tool crash mid-run, say). Trusting the exit code alone would
    // resolve this as an empty-text SUCCESS and even store the session id from a
    // failed run — the latent bug. It must reject instead, and store nothing.
    const child1 = new FakeChild();
    withChild(child1);
    const turn1 = adapter.call(makeInput([{ role: "user", content: "hi" }]));
    child1.pushStdout(
      systemInitLine("sess-doomed") +
        "\n" +
        resultLine({
          isError: true,
          subtype: "error_during_execution",
          errors: ["Execution failed: a tool crashed"],
        }) +
        "\n",
    );
    child1.close(0); // exit 0, but the envelope says is_error
    await expect(turn1).rejects.toThrow(/error result/);
    await expect(turn1).rejects.toThrow(/a tool crashed/);

    // No session was stored from the failed run: turn 2 on the same thread must
    // spawn WITHOUT --resume (a first turn again, not a continuation).
    const child2 = new FakeChild();
    withChild(child2);
    const turn2 = adapter.call(makeInput([{ role: "user", content: "again" }]));
    child2.pushStdout(assistantLine("ok") + "\n");
    child2.close(0);
    await turn2;

    expect(argvAt(1)).not.toContain("--resume");
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

      // The injected logger received diagnostics (don't pin the exact wording
      // — that breaks on any message rewording; routing is what matters).
      expect(logger.log).toHaveBeenCalled();
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

// --- 8. factory skillPath injection -----------------------------------------

describe("claudeCodeAgent factory skillPath injection", () => {
  let tmpDir: string;
  let skillSrcDir: string;

  beforeEach(() => {
    // A trusted-fixture working dir + a source skill directory whose NAME is
    // the skill name (`injectSkill` derives it from the SKILL.md's parent dir).
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-skill-wd-"));
    skillSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-skill-src-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(skillSrcDir, { recursive: true, force: true });
  });

  it("injects the SKILL.md and writes a pointing CLAUDE.md as a construction side effect", () => {
    const skillName = "demo-skill";
    const skillHome = path.join(skillSrcDir, skillName);
    fs.mkdirSync(skillHome, { recursive: true });
    const skillPath = path.join(skillHome, "SKILL.md");
    fs.writeFileSync(skillPath, "# Demo Skill\nDo the demo thing.\n");

    const agent = claudeCodeAgent({ workingDirectory: tmpDir, skillPath });
    expect(agent).toBeInstanceOf(ClaudeCodeAgentAdapter);

    // The skill was copied into <wd>/.skills/<name>/SKILL.md ...
    const injectedSkill = path.join(tmpDir, ".skills", skillName, "SKILL.md");
    expect(fs.existsSync(injectedSkill)).toBe(true);
    expect(fs.readFileSync(injectedSkill, "utf8")).toContain("Demo Skill");

    // ... and a CLAUDE.md pointing at it was written.
    const claudeMd = path.join(tmpDir, "CLAUDE.md");
    expect(fs.existsSync(claudeMd)).toBe(true);
    expect(fs.readFileSync(claudeMd, "utf8")).toContain(
      `.skills/${skillName}/SKILL.md`,
    );
  });
});

// --- 5c. timeout validation -------------------------------------------------

describe("ClaudeCodeAgentAdapter timeout validation", () => {
  it("rejects with a config error when timeout is 0", async () => {
    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      timeout: 0,
    });
    await expect(
      adapter.call(makeInput([{ role: "user", content: "hello" }])),
    ).rejects.toThrow(/positive, finite/);
  });

  it("rejects with a config error when timeout is negative", async () => {
    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      timeout: -5,
    });
    await expect(
      adapter.call(makeInput([{ role: "user", content: "hello" }])),
    ).rejects.toThrow(/positive, finite/);
  });

  it("rejects with a config error when timeout is NaN", async () => {
    const adapter = new ClaudeCodeAgentAdapter({
      workingDirectory: "/tmp/x",
      timeout: NaN,
    });
    await expect(
      adapter.call(makeInput([{ role: "user", content: "hello" }])),
    ).rejects.toThrow(/positive, finite/);
  });
});

// --- 5d. signal termination -------------------------------------------------

describe("ClaudeCodeAgentAdapter signal termination", () => {
  it("rejects with a signal error when close fires with exitCode null and a signal", async () => {
    const child = new FakeChild();
    withChild(child);

    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });
    const p = adapter.call(SIMPLE_INPUT);
    child.emit("close", null, "SIGKILL");

    await expect(p).rejects.toThrow(/terminated by signal SIGKILL/);
  });

  it("includes captured stderr in the signal rejection message", async () => {
    const child = new FakeChild();
    withChild(child);

    const adapter = new ClaudeCodeAgentAdapter({ workingDirectory: "/tmp/x" });
    const p = adapter.call(SIMPLE_INPUT);
    child.pushStderr("OOM killer struck");
    child.emit("close", null, "SIGKILL");

    await expect(p).rejects.toThrow(/OOM killer struck/);
  });
});

// --- 7b. assertSkillWasRead scoping -----------------------------------------

describe("assertSkillWasRead scoping", () => {
  it("throws when only a DIFFERENT skill's SKILL.md is referenced", () => {
    const state = stateWith([
      {
        role: "assistant",
        content: "I read .skills/other-skill/SKILL.md and followed it.",
      },
    ]);
    expect(() => assertSkillWasRead(state, "my-skill")).toThrow(/my-skill/);
  });

  it("passes when the named skill's SKILL.md is referenced (dot-skills path)", () => {
    const state = stateWith([
      {
        role: "assistant",
        content: "I read .skills/my-skill/SKILL.md and followed it.",
      },
    ]);
    expect(() => assertSkillWasRead(state, "my-skill")).not.toThrow();
  });

  it("passes when the named skill's SKILL.md is referenced (no-dot path)", () => {
    const state = stateWith([
      {
        role: "assistant",
        content: "I read skills/my-skill/SKILL.md and followed it.",
      },
    ]);
    expect(() => assertSkillWasRead(state, "my-skill")).not.toThrow();
  });

  it("throws when only a bare directory path (without /SKILL.md) is referenced", () => {
    const state = stateWith([
      {
        role: "assistant",
        content: "I see the .skills/my-skill directory exists.",
      },
    ]);
    expect(() => assertSkillWasRead(state, "my-skill")).toThrow(/my-skill/);
  });
});

// --- 9. safeStringify never throws ------------------------------------------

describe("safeStringify", () => {
  it("returns '[unserializable value]' when both JSON.stringify and String() throw", () => {
    const evil = {
      toJSON() {
        throw new Error("toJSON throws");
      },
      toString() {
        throw new Error("toString throws");
      },
    };
    // JSON.stringify invokes toJSON → throws; String() invokes toString → throws;
    // inner fallback must return the sentinel string without propagating.
    expect(safeStringify(evil)).toBe("[unserializable value]");
  });

  it("still serializes normal values correctly", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
    expect(safeStringify("hello")).toBe('"hello"');
    expect(safeStringify(null)).toBe("null");
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

      // The judge must actually PASS — not merely return a boolean. This fails
      // loudly if the judge verdict is success:false.
      expect(result.success).toBe(true);

      // And the agent under test must have produced the real answer "4" in an
      // assistant turn (content may be a string or an array of parts).
      const assistantText = result.messages
        .filter((m) => m.role === "assistant")
        .map((m) =>
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        )
        .join("\n");
      expect(assistantText).toContain("4");
    }, 120000);

    it(
      "continues a real multiturn session via --resume (turn 2 recalls a fact from turn 1)",
      async () => {
        // Same unmock/re-import rationale as the single-turn test above —
        // doUnmock + resetModules rebinds the real spawn for this test.
        vi.doUnmock("node:child_process");
        vi.resetModules();
        const scenario = (await import("../../index.js")).default;

        const { openai } = await import("@ai-sdk/openai");
        const judgeModelId =
          process.env.SCENARIO_JUDGE_MODEL ?? "gpt-4.1-mini";

        const agent = scenario.claudeCodeAgent({
          workingDirectory: process.cwd(),
          skipPermissions: true,
          ...(process.env.CLAUDE_CODE_MODEL
            ? { model: process.env.CLAUDE_CODE_MODEL }
            : {}),
        });

        const result = await scenario.run({
          name: "claude-code-e2e-multiturn",
          description:
            "Verifies the adapter's --resume path: agent must recall a token set in turn 1 when asked in turn 2.",
          agents: [
            agent,
            scenario.userSimulatorAgent({ model: openai(judgeModelId) }),
            scenario.judgeAgent({
              model: openai(judgeModelId),
              criteria: [
                "The agent correctly recalls the token KUMQUAT77 from earlier in the conversation.",
              ],
            }),
          ],
          script: [
            scenario.user(
              "Remember this exact token for later: KUMQUAT77. Just acknowledge it.",
            ),
            scenario.agent(),
            scenario.user(
              "What was the exact token I asked you to remember? Reply with just the token.",
            ),
            scenario.agent(),
            scenario.judge(),
          ],
        });

        // Judge must pass — agent recalled the token across turns.
        expect(result.success).toBe(true);

        // Recall must appear in the LAST assistant turn (turn 2's reply on the
        // RESUMED session) — not merely somewhere across both turns. Turn 1's
        // acknowledgment echoes the token, so concatenating all assistant
        // messages would pass even if --resume carried no context. Isolating the
        // final assistant message is what actually proves session continuation.
        const assistantMessages = result.messages.filter(
          (m) => m.role === "assistant",
        );
        const lastAssistant = assistantMessages.at(-1);
        const lastAssistantText =
          typeof lastAssistant?.content === "string"
            ? lastAssistant.content
            : JSON.stringify(lastAssistant?.content ?? "");
        expect(lastAssistantText).toContain("KUMQUAT77");
      },
      180000,
    );

    it(
      "recovers a real vanished session mid-run and still recalls turn 1",
      async () => {
        // The highest-fidelity trigger for a stale session: run the real CLI,
        // then DELETE the on-disk transcript it just wrote. A subsequent
        // `--resume <id>` then exits 1 with "No conversation found with session
        // ID" — the exact failure the in-turn rebuild exists for. No judge and
        // no user simulator, so this needs a `claude` binary but no LLM keys.
        vi.doUnmock("node:child_process");
        vi.resetModules();
        const { ClaudeCodeAgentAdapter: RealAdapter } = await import(
          "../claude-code/index.js"
        );
        const { ScenarioExecution: RealExecution } = await import(
          "../../execution/scenario-execution.js"
        );
        const {
          agent: realAgent,
          succeed: realSucceed,
          user: realUser,
        } = await import("../../script/index.js");

        const workingDirectory = fs.mkdtempSync(
          path.join(os.tmpdir(), "cc-stale-"),
        );
        const spawnLogs: string[] = [];
        const warnLogs: string[] = [];

        const adapter = new RealAdapter({
          workingDirectory,
          timeout: 180000,
          // Opt in to replay — this test's whole point is surviving the
          // vanished session by rebuilding in-turn.
          replayOnLostSession: true,
          ...(process.env.CLAUDE_CODE_MODEL
            ? { model: process.env.CLAUDE_CODE_MODEL }
            : {}),
          logger: {
            log: (...a: unknown[]) => {
              const line = a.join(" ");
              if (line.startsWith("Starting claude in:")) spawnLogs.push(line);
            },
            warn: (...a: unknown[]) => warnLogs.push(a.join(" ")),
          },
        });

        /**
         * Remove the on-disk transcript of the session turn 1 established.
         *
         * This builds a path from a `sessionId` that arrives verbatim from the
         * CLI's stdout, then deletes the file. Harden the primitive so a
         * malformed/hostile id can never escape the projects tree into an
         * arbitrary-file delete:
         *  1. the id must be a strict UUID (rejects any `/`, `..`, or NUL),
         *  2. the resolved candidate must stay contained under the projects dir,
         *  3. the target must be a regular file — reject symlinks (no following
         *     a link out of the tree).
         */
        const UUID_RE =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const deleteLiveSession = (threadId: string): string => {
          const { sessions } = adapter as unknown as {
            sessions: Map<string, string>;
          };
          const sessionId = sessions.get(threadId);
          if (!sessionId) throw new Error("turn 1 captured no session_id");
          if (!UUID_RE.test(sessionId)) {
            throw new Error(`refusing to delete: session id is not a UUID: ${sessionId}`);
          }
          const projects = path.resolve(
            path.join(os.homedir(), ".claude", "projects"),
          );
          const transcript = fs
            .readdirSync(projects)
            .map((dir) => path.resolve(projects, dir, `${sessionId}.jsonl`))
            .find((candidate) => {
              // Contained under the projects tree AND a real file (not a symlink).
              const rel = path.relative(projects, candidate);
              if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
              if (!fs.existsSync(candidate)) return false;
              return fs.lstatSync(candidate).isFile();
            });
          if (!transcript) {
            throw new Error(`no on-disk transcript for session ${sessionId}`);
          }
          fs.rmSync(transcript);
          return sessionId;
        };

        const exec = new RealExecution(
          {
            name: "claude-code-e2e-stale-session",
            description: "turn 2 resumes a session whose transcript is gone",
            agents: [adapter, new StubUserSim()],
          },
          [
            realUser(
              "Remember this exact token for later: ZEBRA42. Just acknowledge it.",
            ),
            realAgent(),
            async (state) => {
              deleteLiveSession(state.threadId);
            },
            realUser(
              "What exact token did I ask you to remember? Reply with just the token.",
            ),
            realAgent(),
            realSucceed("reached the end"),
          ],
          "claude-code-stale-batch",
        );

        // `execute()` rethrows internal errors — including exactly the
        // vanished-session failure this test exists to catch — so cleanup MUST
        // be in a finally, or a failing run would leak the mkdtemp'd dir forever.
        try {
          const result = await exec.execute();

          // The run survived the vanished session…
          expect(result.success).toBe(true);
          // …because turn 2 spawned twice: the doomed resume, then the rebuild.
          expect(spawnLogs).toHaveLength(3);
          expect(
            warnLogs.some((w) => w.includes("no longer exists")),
          ).toBe(true);

          // …and the rebuilt turn still carried turn 1's context forward.
          const assistantMessages = result.messages.filter(
            (m) => m.role === "assistant",
          );
          const lastAssistant = assistantMessages.at(-1);
          const lastAssistantText =
            typeof lastAssistant?.content === "string"
              ? lastAssistant.content
              : JSON.stringify(lastAssistant?.content ?? "");
          expect(lastAssistantText).toContain("ZEBRA42");
        } finally {
          fs.rmSync(workingDirectory, { recursive: true, force: true });
        }
      },
      300000,
    );
  },
);
