/**
 * Unit tests for the OpenCode agent adapter (`OpenCodeAgentAdapter`).
 *
 * Creds-free injection strategy (no real server, no spawn): the tests inject a
 * fake `OpencodeClient` — a plain object whose `session.create` and
 * `session.prompt` are `vi.fn()` spies. The adapter accepts the client via the
 * `client` config field (injection seam; avoids `vi.mock` of the SDK).
 *
 * Coverage:
 *   AC-1  — constructs, implements interface, factory works, call returns string.
 *   AC-2  — one session per threadId; distinct threadIds → distinct sessions.
 *   AC-3  — prompt body = latest user message; return = concatenated text parts.
 *   AC-6  — partsToText: only text parts concatenated; unknown parts skipped (no
 *            throw); info.error → reject (R2 HTTP-200 semantic error); transport
 *            error → reject; empty parts → reject; non-text-only → non-empty
 *            fallback (R3).
 *   empty-input guard — agent-first (newMessages=[]) → reject before any RPC.
 *   R4 continuation eviction — stale sessionId evicted after prompt error; next
 *            call recreates session.
 *   AC-4 (env-gated) — live multi-turn coding scenario.
 *
 * Plus an env-gated integration test (skipped unless `RUN_OPENCODE_E2E=1`)
 * that runs a real `scenario.run(...)` with `openCodeAgent` and a real judge.
 */

import fs from "fs";
import os from "os";
import path from "path";

import type { OpencodeClient } from "@opencode-ai/sdk";
import type { ModelMessage } from "ai";
import { describe, it, expect, vi, type Mock } from "vitest";

// OpencodeClient is type-only — the adapter owns the real SDK import at
// runtime. We import the type purely so we can cast our fake to it.

import { AgentRole, type AgentInput } from "../../domain";
import { AgentAdapter } from "../../domain";
import {
  OpenCodeAgentAdapter,
  openCodeAgent,
  type OpenCodeAgentAdapterConfig,
} from "../opencode/index.js";

// ---------------------------------------------------------------------------
// Fake client helpers
// ---------------------------------------------------------------------------

/** Minimal part shapes the tests push through. */
interface FakePart {
  type: string;
  text?: string;
  ignored?: boolean;
  [k: string]: unknown;
}

/** Default prompt success response. */
function promptOk(parts: FakePart[] = [{ type: "text", text: "hello" }]) {
  return { data: { info: {}, parts }, error: undefined };
}

/** Default session create success response. */
function sessionOk(id = "sess-1") {
  return { data: { id }, error: undefined };
}

/**
 * Build a typed fake `OpencodeClient`. The real SDK's `session.create` and
 * `session.prompt` both follow the "fields" responseStyle — they resolve to
 * `{ data, error }` — never throw. Our fakes mirror that contract exactly.
 */
function makeFakeClient(opts: {
  createResult?: () => unknown;
  promptResult?: () => unknown;
} = {}): {
  client: OpencodeClient;
  createSpy: Mock;
  promptSpy: Mock;
} {
  const createSpy = vi.fn(opts.createResult ?? (() => sessionOk()));
  const promptSpy = vi.fn(opts.promptResult ?? (() => promptOk()));

  const client = {
    session: {
      create: createSpy,
      prompt: promptSpy,
    },
  } as unknown as OpencodeClient;

  return { client, createSpy, promptSpy };
}

// ---------------------------------------------------------------------------
// Input fixtures
// ---------------------------------------------------------------------------

function makeInput(
  messages: ModelMessage[],
  opts: {
    threadId?: string;
    newMessages?: ModelMessage[];
  } = {},
): AgentInput {
  return {
    threadId: opts.threadId ?? "opencode-thread",
    messages,
    // Mirror #687: default newMessages to full history (first-turn shape).
    newMessages: opts.newMessages ?? messages,
    requestedRole: AgentRole.AGENT,
    scenarioState: {} as unknown as AgentInput["scenarioState"],
    scenarioConfig: {
      name: "opencode-test",
      description: "A test scenario.",
    } as unknown as AgentInput["scenarioConfig"],
  } as AgentInput;
}

const SIMPLE_USER_MSG: ModelMessage = { role: "user", content: "hello" };

const SIMPLE_INPUT = makeInput([SIMPLE_USER_MSG]);

/** Build a minimal config with an injected client. */
function makeConfig(
  client: OpencodeClient,
  overrides: Partial<Omit<OpenCodeAgentAdapterConfig, "client" | "model">> = {},
): OpenCodeAgentAdapterConfig {
  return {
    // workingDirectory is required (the adapter refuses to run the tool-bearing
    // agent in an unspecified cwd); a placeholder is fine for the injected-client
    // unit tests, which never spawn a real server. Tests that assert directory
    // forwarding override it via `overrides`.
    model: { providerID: "openai", modelID: "gpt-5.4-mini" },
    workingDirectory: "/tmp/opencode-unit-wd",
    client,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1 — interface conformance
// ---------------------------------------------------------------------------

describe("OpenCodeAgentAdapter AC-1 — interface conformance", () => {
  it("is an instance of AgentAdapter", () => {
    const { client } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));
    expect(adapter).toBeInstanceOf(AgentAdapter);
  });

  it("exposes role === AgentRole.AGENT", () => {
    const { client } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));
    expect(adapter.role).toBe(AgentRole.AGENT);
  });

  it('has name === "OpenCodeAgent"', () => {
    const { client } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));
    expect(adapter.name).toBe("OpenCodeAgent");
  });

  it("openCodeAgent factory returns an OpenCodeAgentAdapter", () => {
    const { client } = makeFakeClient();
    const adapter = openCodeAgent(makeConfig(client));
    expect(adapter).toBeInstanceOf(OpenCodeAgentAdapter);
  });

  it("call(input) resolves to a string through the fake client", async () => {
    const { client } = makeFakeClient({
      promptResult: () => promptOk([{ type: "text", text: "world" }]),
    });
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));
    const result = await adapter.call(SIMPLE_INPUT);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-2 — session-per-threadId
// ---------------------------------------------------------------------------

describe("OpenCodeAgentAdapter AC-2 — session-per-threadId", () => {
  it("calls session.create exactly once for three calls on the same threadId", async () => {
    const { client, createSpy, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    await adapter.call(makeInput([SIMPLE_USER_MSG]));
    await adapter.call(makeInput([SIMPLE_USER_MSG]));
    await adapter.call(makeInput([SIMPLE_USER_MSG]));

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy).toHaveBeenCalledTimes(3);
  });

  it("passes the created session id as path.id on every prompt call", async () => {
    const sessionId = "sess-sticky";
    const { client, createSpy, promptSpy } = makeFakeClient({
      createResult: () => sessionOk(sessionId),
    });
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    await adapter.call(makeInput([SIMPLE_USER_MSG]));
    await adapter.call(makeInput([SIMPLE_USER_MSG]));

    expect(createSpy).toHaveBeenCalledTimes(1);
    for (const call of promptSpy.mock.calls) {
      const opts = call[0] as { path?: { id?: string } };
      expect(opts?.path?.id).toBe(sessionId);
    }
  });

  it("calls session.create a second time for a different threadId", async () => {
    const { client, createSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    await adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "thread-A" }));
    await adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "thread-B" }));

    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("uses distinct session ids for distinct threadIds", async () => {
    let callCount = 0;
    const { client, promptSpy } = makeFakeClient({
      createResult: () => sessionOk(`sess-${++callCount}`),
    });
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    await adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "thread-A" }));
    await adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "thread-B" }));

    const promptCallA = promptSpy.mock.calls[0]?.[0] as { path?: { id?: string } };
    const promptCallB = promptSpy.mock.calls[1]?.[0] as { path?: { id?: string } };
    expect(promptCallA?.path?.id).not.toBe(promptCallB?.path?.id);
  });
});

// ---------------------------------------------------------------------------
// AC-3 — latest user message forwarded; reply returned
// ---------------------------------------------------------------------------

describe("OpenCodeAgentAdapter AC-3 — sends latest user message, returns reply", () => {
  it("sends the new user message text as the prompt body text part", async () => {
    const { client, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    await adapter.call(makeInput([{ role: "user", content: "UNIQUE_USER_TEXT" }]));

    const opts = promptSpy.mock.calls[0]?.[0] as {
      body?: { parts?: Array<{ type: string; text?: string }> };
    };
    const textPart = opts?.body?.parts?.find((p) => p.type === "text");
    expect(textPart?.text).toContain("UNIQUE_USER_TEXT");
  });

  it("returns the concatenated text parts from the assistant reply", async () => {
    const { client } = makeFakeClient({
      promptResult: () => promptOk([{ type: "text", text: "REPLY_CONTENT" }]),
    });
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    const result = await adapter.call(SIMPLE_INPUT);
    expect(result).toContain("REPLY_CONTENT");
  });

  it("renders array-shaped user content (content blocks) to text", async () => {
    const { client, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    // User message whose content is an array of blocks (not a plain string).
    await adapter.call(
      makeInput([
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        } as unknown as ModelMessage,
      ]),
    );

    const opts = promptSpy.mock.calls[0]?.[0] as {
      body?: { parts?: Array<{ type: string; text?: string }> };
    };
    const textPart = opts?.body?.parts?.find((p) => p.type === "text");
    expect(textPart?.text).toContain("hi");
  });

  it("returns a non-empty string (the returned reply is not empty)", async () => {
    const { client } = makeFakeClient({
      promptResult: () => promptOk([{ type: "text", text: "not empty" }]),
    });
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));
    const result = await adapter.call(SIMPLE_INPUT);
    expect((result as string).trim().length).toBeGreaterThan(0);
  });

  it("excludes assistant-role messages from the prompt (only user turns are sent)", async () => {
    const { client, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    // Delta carrying BOTH an assistant echo and a user turn: only the user text
    // is forwarded — OpenCode already holds the assistant turn server-side.
    await adapter.call(
      makeInput([SIMPLE_USER_MSG], {
        newMessages: [
          { role: "assistant", content: "ASSISTANT_ECHO" },
          { role: "user", content: "USER_TEXT" },
        ],
      }),
    );

    const opts = promptSpy.mock.calls[0]?.[0] as {
      body?: { parts?: Array<{ type: string; text?: string }> };
    };
    const textPart = opts?.body?.parts?.find((p) => p.type === "text");
    expect(textPart?.text).toContain("USER_TEXT");
    expect(textPart?.text).not.toContain("ASSISTANT_ECHO");
  });

  it("forwards the configured model to the session.prompt body", async () => {
    const { client, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    await adapter.call(SIMPLE_INPUT);

    const opts = promptSpy.mock.calls[0]?.[0] as { body?: { model?: unknown } };
    expect(opts?.body?.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4-mini",
    });
  });

  it("forwards workingDirectory as query.directory on session.create AND session.prompt", async () => {
    const { client, createSpy, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(
      makeConfig(client, { workingDirectory: "/tmp/wd-x" }),
    );

    await adapter.call(SIMPLE_INPUT);

    const createOpts = createSpy.mock.calls[0]?.[0] as {
      query?: { directory?: string };
    };
    const promptOpts = promptSpy.mock.calls[0]?.[0] as {
      query?: { directory?: string };
    };
    expect(createOpts?.query?.directory).toBe("/tmp/wd-x");
    expect(promptOpts?.query?.directory).toBe("/tmp/wd-x");
  });
});

// ---------------------------------------------------------------------------
// AC-6 + R2/R3 — partsToText filtering and error surfaces
// ---------------------------------------------------------------------------

describe("OpenCodeAgentAdapter AC-6/R2/R3 — parts filtering and error handling", () => {
  describe("given mixed parts (text + non-text)", () => {
    it("concatenates only text parts and does not throw", async () => {
      const mixedParts: FakePart[] = [
        { type: "text", text: "A" },
        { type: "tool", name: "bash", input: { cmd: "ls" } },
        { type: "step-start" },
        { type: "reasoning", text: "think" },
        { type: "made-up-future", foo: 1 },
        { type: "text", text: "B" },
      ];
      const { client } = makeFakeClient({
        promptResult: () => promptOk(mixedParts),
      });
      const adapter = new OpenCodeAgentAdapter(makeConfig(client));

      const result = await adapter.call(SIMPLE_INPUT);
      expect(result).toContain("A");
      expect(result).toContain("B");
      // Non-text type discriminators must NOT appear verbatim in the final text.
      expect(result).not.toContain("step-start");
      expect(result).not.toContain("reasoning");
      // A reasoning part's own TEXT must not leak — only visible text parts pass.
      expect(result).not.toContain("think");
    });
  });

  describe("given a text part with ignored: true", () => {
    it("skips the ignored part and does not include its text", async () => {
      const parts: FakePart[] = [
        { type: "text", text: "IGNORED_PART", ignored: true },
        { type: "text", text: "VISIBLE_PART" },
      ];
      const { client } = makeFakeClient({
        promptResult: () => promptOk(parts),
      });
      const adapter = new OpenCodeAgentAdapter(makeConfig(client));

      const result = await adapter.call(SIMPLE_INPUT);
      expect(result).not.toContain("IGNORED_PART");
      expect(result).toContain("VISIBLE_PART");
    });
  });

  describe("given a semantic error in info.error (R2 — HTTP 200 with error)", () => {
    it("rejects with a non-empty error message when info.error is truthy", async () => {
      const { client } = makeFakeClient({
        promptResult: () => ({
          data: {
            info: { error: { name: "MessageOutputLengthError", message: "too long" } },
            parts: [],
          },
          error: undefined,
        }),
      });
      const adapter = new OpenCodeAgentAdapter(makeConfig(client));

      // Strict: a single rejects assertion that also proves the thrown message
      // NAMES the semantic error variant (describeError surfaced info.error),
      // rather than a try/catch that would silently pass if call() resolved.
      await expect(adapter.call(SIMPLE_INPUT)).rejects.toThrow(
        /MessageOutputLengthError/,
      );
    });
  });

  describe("given a transport error (result.error is set) (R2 — transport layer)", () => {
    it("rejects when result.error is truthy", async () => {
      const { client } = makeFakeClient({
        promptResult: () => ({
          data: undefined,
          error: { status: 500, message: "internal server error" },
        }),
      });
      const adapter = new OpenCodeAgentAdapter(makeConfig(client));

      // Assert on describeError's INTERPOLATED output (message + status), not
      // just the static "prompt failed" prefix — otherwise a regression that
      // guts describeError to a constant string would still pass this test.
      await expect(adapter.call(SIMPLE_INPUT)).rejects.toThrow(
        /prompt failed: internal server error \(status 500\)/,
      );
    });
  });

  describe("given an empty parts array with no info.error (R3 — truly empty response)", () => {
    it("rejects when parts is empty and info has no error", async () => {
      const { client } = makeFakeClient({
        promptResult: () => ({ data: { info: {}, parts: [] }, error: undefined }),
      });
      const adapter = new OpenCodeAgentAdapter(makeConfig(client));

      await expect(adapter.call(SIMPLE_INPUT)).rejects.toThrow();
    });
  });

  describe("given only non-text parts (R3 — non-empty fallback)", () => {
    it("resolves to a non-empty string when all parts are non-text (tool-use fallback)", async () => {
      const parts: FakePart[] = [
        { type: "tool", name: "bash", input: { cmd: "echo hi" } },
      ];
      const { client } = makeFakeClient({
        promptResult: () => promptOk(parts),
      });
      const adapter = new OpenCodeAgentAdapter(makeConfig(client));

      const result = await adapter.call(SIMPLE_INPUT);
      // Must resolve (not reject) and the result must be a non-empty string.
      expect(typeof result).toBe("string");
      expect((result as string).trim().length).toBeGreaterThan(0);
      // ...and READ readably — naming the tool, not "[object Object]" (renderNonTextPart → `[tool: bash]`).
      expect(result).toContain("bash");
    });
  });
});

// ---------------------------------------------------------------------------
// Empty-input guard — agent-first (no user turn)
// ---------------------------------------------------------------------------

describe("OpenCodeAgentAdapter empty-input guard", () => {
  it("rejects before calling session.create or session.prompt when newMessages is empty", async () => {
    const { client, createSpy, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    // Agent-first shape: the newMessages delta is empty (no user content).
    await expect(
      adapter.call(makeInput([SIMPLE_USER_MSG], { newMessages: [] })),
    ).rejects.toThrow();

    expect(createSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("rejects with a message indicating a user turn is required", async () => {
    const { client } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    await expect(
      adapter.call(makeInput([SIMPLE_USER_MSG], { newMessages: [] })),
    ).rejects.toThrow(/user/i);
  });
});

// ---------------------------------------------------------------------------
// R4 — continuation eviction after prompt error
// ---------------------------------------------------------------------------

describe("OpenCodeAgentAdapter R4 — stale session eviction after prompt error", () => {
  it("calls session.create again on the third call after the second call's prompt fails", async () => {
    let promptCallIndex = 0;
    const { client, createSpy, promptSpy } = makeFakeClient({
      promptResult: () => {
        promptCallIndex++;
        if (promptCallIndex === 2) {
          // Second prompt call fails with a transport error.
          return { data: undefined, error: { status: 503, message: "unavailable" } };
        }
        return promptOk();
      },
    });
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    // Call 1: succeeds — session created.
    await adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "evict-thread" }));
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Call 2: prompt fails — session should be evicted.
    await expect(
      adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "evict-thread" })),
    ).rejects.toThrow();

    // Call 3: same threadId — create must be called AGAIN (stale id evicted).
    await adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "evict-thread" }));
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(promptSpy).toHaveBeenCalledTimes(3);
  });

  it("rejects when session.create fails and recreates the session on the next call", async () => {
    let createCalls = 0;
    const { client, createSpy } = makeFakeClient({
      createResult: () => {
        createCalls++;
        return createCalls === 1
          ? { data: undefined, error: { status: 503, message: "unavailable" } }
          : sessionOk("sess-ok");
      },
    });
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));
    // Pin describeError's INTERPOLATED output (message + status), not just the
    // static "session.create failed" prefix — otherwise gutting describeError to
    // a constant string would leave this test green.
    await expect(
      adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "create-fail" })),
    ).rejects.toThrow(/session\.create failed for thread "create-fail": unavailable \(status 503\)/);
    // next call on the same thread must retry create (stale rejected promise evicted)
    await adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "create-fail" }));
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Concurrency + config validation
// ---------------------------------------------------------------------------

describe("OpenCodeAgentAdapter concurrency + config validation", () => {
  it("dedupes concurrent first-calls on the same threadId to ONE session.create", async () => {
    // Gate the create on a manual deferred so BOTH calls are genuinely in-flight
    // before either resolves — otherwise the first call could finish creating
    // before the second even starts, and the test would pass without the fix.
    let releaseCreate!: () => void;
    const gate = new Promise<void>((r) => { releaseCreate = r; });
    const { client, createSpy } = makeFakeClient({
      createResult: () => gate.then(() => sessionOk("sess-1")),
    });
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));
    const p1 = adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "race" }));
    const p2 = adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "race" }));
    await Promise.resolve(); // let both reach resolveSessionId and share the in-flight create
    releaseCreate();
    await Promise.all([p1, p2]);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("propagates ONE rejecting session.create to ALL concurrent first-calls, then retries cleanly", async () => {
    // The dedup map stores the create PROMISE un-awaited (that is the dedup
    // mechanism — awaiting before storing would reopen the check-then-create
    // race). This test pins the rejection half of that contract: every path
    // that reads the stored promise awaits it, so a failing create rejects
    // BOTH concurrent callers (no unhandled rejection, no hang), is evicted,
    // and the next turn retries with a fresh create.
    let releaseCreate!: () => void;
    const gate = new Promise<void>((r) => { releaseCreate = r; });
    let createCalls = 0;
    const { client, createSpy } = makeFakeClient({
      createResult: () => {
        createCalls++;
        return createCalls === 1
          ? gate.then(() => ({ data: undefined, error: { status: 503, message: "unavailable" } }))
          : sessionOk("sess-retry");
      },
    });
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    const p1 = adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "race-reject" }));
    const p2 = adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "race-reject" }));
    // Observe BOTH rejections immediately via allSettled — it attaches handlers
    // synchronously, so neither rejection is ever unobserved — rather than storing
    // deferred `expect(...).rejects` assertions and awaiting them later. That
    // deferred pattern is deprecated in vitest and, on a real regression, splits
    // one failure into a waitFor timeout plus a disconnected unhandled rejection.
    const settled = Promise.allSettled([p1, p2]);
    // Wait for a macrotask boundary (vi.waitFor polls on timers), which drains
    // BOTH calls' microtask chains regardless of call()'s internal await depth:
    // p1 is parked inside the gated create, p2 is attached to the same stored
    // promise. Decoupled from await topology — inserting an await inside
    // call()/resolveSessionId cannot break this synchronization.
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    releaseCreate();
    const results = await settled;
    // Both concurrent callers reject with the SAME create-failed error — content
    // pinned (message + status), not just the static prefix.
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    for (const r of results) {
      const reason = (r as PromiseRejectedResult).reason as Error;
      expect(reason).toBeInstanceOf(Error);
      expect(reason.message).toMatch(
        /session\.create failed for thread "race-reject": unavailable \(status 503\)/,
      );
    }
    // Both concurrent callers shared ONE create attempt.
    expect(createSpy).toHaveBeenCalledTimes(1);

    // The rejected promise was evicted — the next turn retries and succeeds.
    await adapter.call(makeInput([SIMPLE_USER_MSG], { threadId: "race-reject" }));
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("throws on timeout=0 (explicitly set, not silently ignored) before any RPC", async () => {
    const { client, createSpy, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client, { timeout: 0 }));

    await expect(adapter.call(SIMPLE_INPUT)).rejects.toThrow(/timeout/i);
    expect(createSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("throws on a negative timeout", async () => {
    const { client } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client, { timeout: -5 }));

    await expect(adapter.call(SIMPLE_INPUT)).rejects.toThrow(/timeout/i);
  });

  // validateTimeout() is the SOLE guard in front of AbortSignal.timeout(), which
  // throws a raw TypeError on a non-finite input. Pin both non-finite values, or
  // dropping the Number.isFinite check would surface that TypeError to callers
  // instead of the friendly validation message.
  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("throws on a non-finite timeout (%s) before any RPC", async (_label, timeout) => {
    const { client, createSpy, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client, { timeout }));

    await expect(adapter.call(SIMPLE_INPUT)).rejects.toThrow(
      /timeout must be a positive, finite number/i,
    );
    expect(createSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("forwards an AbortSignal to session.prompt when a positive timeout is set", async () => {
    const { client, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client, { timeout: 5000 }));

    await adapter.call(SIMPLE_INPUT);

    const opts = promptSpy.mock.calls[0]?.[0] as { signal?: unknown };
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// close() — teardown is callable
// ---------------------------------------------------------------------------

describe("OpenCodeAgentAdapter close()", () => {
  it("resolves without error when close() is called on an injected-client adapter", async () => {
    const { client } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("rejects call() after close() with a clear closed-adapter error (no RPC attempted)", async () => {
    // close() is terminal: a post-close call must fail with the real cause
    // ("adapter is closed"), not race a torn-down server into an opaque
    // transport error — the close()/call() sequencing gap from review.
    const { client, createSpy, promptSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));
    await adapter.close();

    await expect(adapter.call(SIMPLE_INPUT)).rejects.toThrow(/closed/i);
    expect(createSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("is idempotent — a second close() resolves and the adapter stays closed", async () => {
    // Double-close is ordinary teardown code (a finally plus an afterAll both
    // closing). The guard makes repeat close() a no-op instead of re-driving
    // teardown against an already-closed server.
    const { client, createSpy } = makeFakeClient();
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));
    await adapter.close();

    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(adapter.call(SIMPLE_INPUT)).rejects.toThrow(/closed/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("lets a call() already past the closed-guard complete normally when close() runs mid-flight", async () => {
    // The guard is entry-only BY DESIGN (ADR-005 §10): teardown sequencing is
    // the caller's contract. This pins the injected-client sub-case: an
    // in-flight call is not corrupted or cancelled by a concurrent close() —
    // it completes; only the NEXT call is rejected.
    let releasePrompt!: () => void;
    const gate = new Promise<void>((r) => { releasePrompt = r; });
    const { client, promptSpy } = makeFakeClient({
      promptResult: () =>
        gate.then(() => promptOk([{ type: "text", text: "mid-flight ok" }])),
    });
    const adapter = new OpenCodeAgentAdapter(makeConfig(client));

    const inFlight = adapter.call(SIMPLE_INPUT);
    // Macrotask-boundary wait: the call is past the guard and parked inside
    // the gated prompt before close() runs.
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalledTimes(1));
    await adapter.close();
    releasePrompt();

    await expect(inFlight).resolves.toContain("mid-flight ok");
    await expect(adapter.call(SIMPLE_INPUT)).rejects.toThrow(/closed/i);
  });
});

// ---------------------------------------------------------------------------
// AC-4 env-gated integration (RUN_OPENCODE_E2E=1) — live multi-turn scenario
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.RUN_OPENCODE_E2E)(
  "OpenCodeAgentAdapter integration (RUN_OPENCODE_E2E=1)",
  () => {
    it(
      "runs a multi-turn coding scenario with a real judge and returns a passing verdict",
      async () => {
        // Dynamic import keeps the heavy scenario barrel out of the unit-test path; loaded only when the env-gated e2e runs.
        const scenario = (await import("../../index.js")).default;
        const { openai } = await import("@ai-sdk/openai");

        const judgeModelId = process.env.SCENARIO_JUDGE_MODEL ?? "gpt-5.4-mini";

        // Isolate this tool-bearing agent (shell + file read/write) from the
        // repo: process.cwd() is javascript/, which holds a gitignored .env with
        // a real OPENAI_API_KEY. Run it in an empty temp dir instead — the two
        // scripted prompts reference no pre-existing files.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-e2e-"));

        // Use the real openCodeAgent — NO injected client, lets the adapter
        // spawn the opencode binary (requires opencode on PATH + provider keys).
        //
        // `timeout` must stay BELOW this test's 180s vitest timeout. A live
        // prompt can stall (observed ~1 run in 6); without a bound, vitest kills
        // the test body and the `finally` below never runs, leaking the temp dir
        // and the spawned server. Bounded, the stall rejects inside the test, so
        // teardown still happens and the failure names its own cause.
        const agent = openCodeAgent({
          model: {
            providerID: process.env.OPENCODE_PROVIDER_ID ?? "openai",
            modelID: process.env.OPENCODE_MODEL_ID ?? "gpt-5.4-mini",
          },
          timeout: 120_000,
          workingDirectory: tmpDir,
        });

        try {
          const result = await scenario.run({
            name: "opencode-e2e-multiturn",
            description:
              "Verifies the OpenCode adapter in a multi-turn coding scenario: " +
              "user asks the agent to write a simple function, then add a test for it.",
            agents: [
              agent,
              scenario.userSimulatorAgent({ model: openai(judgeModelId) }),
              scenario.judgeAgent({
                model: openai(judgeModelId),
                criteria: [
                  "The agent writes a working JavaScript/TypeScript function that adds two numbers.",
                  "The agent acknowledges or writes a test for the function when asked.",
                ],
              }),
            ],
            script: [
              scenario.user(
                "Write a JavaScript function called `add` that takes two numbers and returns their sum. " +
                "Just the function definition, no file operations needed.",
              ),
              scenario.agent(),
              scenario.user(
                "Now write a simple unit test for the `add` function you just wrote. " +
                "Just the test code, using any test style you like.",
              ),
              scenario.agent(),
              scenario.judge(),
            ],
          });

          expect(result.success).toBe(true);

          // Verify there are at least two non-empty assistant turns.
          const assistantTurns = result.messages.filter(
            (m: ModelMessage) => m.role === "assistant",
          );
          expect(assistantTurns.length).toBeGreaterThanOrEqual(2);

          // The last assistant turn must mention the function or test in some form.
          const lastAssistant = assistantTurns.at(-1);
          const lastText =
            typeof lastAssistant?.content === "string"
              ? lastAssistant.content
              : JSON.stringify(lastAssistant?.content ?? "");
          expect(lastText.trim().length).toBeGreaterThan(0);
        } finally {
          // Tear down the auto-spawned opencode server so it does not leak its
          // port bind to the next run (serial e2e runs would otherwise collide),
          // then remove the temp working dir — even if close() throws.
          try {
            await agent.close();
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        }
      },
      180000,
    );
  },
);
