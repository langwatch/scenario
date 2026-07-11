/**
 * SPIKE #779 — load-bearing unit tests for the CC transcript reader/adapter.
 * These run against a REAL Claude Code session JSONL (fixtures/real-cc-session.jsonl,
 * the KUMQUAT77 memory-recall session from the PR #687 work). No API calls.
 *
 * Each test pins a normalization that a naive "read top-to-bottom" transform gets wrong.
 * Mutation-checked: breaking the parentUuid walk, the same-id assistant merge, or the
 * tool_use→tool_result name recovery turns these red (see PROTOTYPE.md §mutation).
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseSessionFile,
  linearize,
  normalize,
  classifyUser,
  toModelMessages,
} from "./cc-transcript";
import { buildScenarioFromTranscript } from "./from-transcript";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "real-cc-session.jsonl");

describe("cc-transcript reader (real JSONL)", () => {
  const raw = parseSessionFile(FIXTURE);
  const chain = linearize(raw);
  const turns = normalize(chain);

  it("parses the real session and keeps only uuid-bearing nodes", () => {
    expect(raw.length).toBeGreaterThan(40);
    expect(raw.every((n) => !!n.uuid)).toBe(true);
  });

  it("walks the parentUuid chain leaf→root (not file order) into a single linear path", () => {
    // every node except the root must have its parent immediately preceding it
    const uuids = new Set(chain.map((n) => n.uuid));
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].parentUuid).toBe(chain[i - 1].uuid);
    }
    expect(uuids.size).toBe(chain.length); // no dup / cycle
  });

  it("drops non-conversational metadata (attachment/system) after normalization", () => {
    const rawTypes = new Set(raw.map((n) => n.type));
    expect(rawTypes.has("attachment")).toBe(true); // fixture really has metadata lines
    // normalized turns are only user/assistant/tool
    expect(turns.every((t) => ["user", "assistant", "tool"].includes(t.role))).toBe(true);
  });

  it("distinguishes the overloaded user role: genuine human vs command-injection vs tool_result", () => {
    const humans = turns.filter((t) => t.role === "user" && t.userKind === "human");
    const injected = turns.filter((t) => t.role === "user" && t.userKind === "injected");
    const toolResults = turns.filter((t) => t.role === "tool");
    // 2 genuine human turns: the "remember KUMQUAT77" ask and the "what was the token?" question
    expect(humans.length).toBe(2);
    expect(humans[0].text).toMatch(/remember/i);
    expect(humans[0].text).toMatch(/KUMQUAT77/);
    expect(humans[1].text).toMatch(/what was the exact token/i);
    // /respond and /how-do-i skill dumps are injected user turns, NOT genuine human
    expect(injected.length).toBeGreaterThanOrEqual(2);
    // real tool I/O was captured
    expect(toolResults.length).toBeGreaterThanOrEqual(4);
  });

  it("re-merges an assistant message split across multiple JSONL lines (same message.id)", () => {
    // The first assistant turn is thinking + text + tool_use(Write) across 3 lines → ONE turn
    const firstAssistant = turns.find((t) => t.role === "assistant")!;
    expect(firstAssistant.thinking && firstAssistant.thinking.length).toBeGreaterThan(0); // thinking captured
    expect(firstAssistant.toolCalls?.some((c) => c.name === "Write")).toBe(true); // merged tool_use
  });

  it("recovers toolName for every tool_result by pairing back to its tool_use id", () => {
    const results = turns.filter((t) => t.role === "tool").flatMap((t) => t.toolResults ?? []);
    expect(results.length).toBeGreaterThan(0);
    // none should fall back to the unknown sentinel — the id→name map must resolve them
    expect(results.every((r) => r.name !== "unknown_tool")).toBe(true);
    expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(["Write"]));
  });

  it("captures extended thinking blocks (they exist in the real transcript)", () => {
    const anyThinking = turns.some((t) => t.role === "assistant" && (t.thinking?.length ?? 0) > 0);
    expect(anyThinking).toBe(true);
  });
});

describe("Anthropic → AI-SDK v6 ModelMessage emission", () => {
  const turns = normalize(linearize(parseSessionFile(FIXTURE)));

  it("emits valid v6 tool-result parts (toolName + output:{type:text,value})", () => {
    const msgs = toModelMessages(turns);
    const toolMsg = msgs.find((m) => m.role === "tool") as any;
    expect(toolMsg).toBeTruthy();
    const part = toolMsg.content[0];
    expect(part.type).toBe("tool-result");
    expect(typeof part.toolName).toBe("string");
    expect(part.output).toEqual(expect.objectContaining({ type: "text" }));
    expect(typeof part.output.value).toBe("string");
  });

  it("emits assistant tool-call parts with input (v6), and drops thinking by default", () => {
    const msgs = toModelMessages(turns);
    const withToolCall = msgs.find(
      (m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((p) => p.type === "tool-call")
    ) as any;
    expect(withToolCall).toBeTruthy();
    const call = (withToolCall.content as any[]).find((p) => p.type === "tool-call");
    expect(call).toEqual(expect.objectContaining({ type: "tool-call", toolName: expect.any(String) }));
    expect("input" in call).toBe(true);
    // thinking must NOT leak into the emitted messages by default (invalid for non-Anthropic models)
    const anyThinkingText = JSON.stringify(msgs).includes("[thinking]");
    expect(anyThinkingText).toBe(false);
  });
});

describe("fromTranscript builder + DoD-4 turn-free seeding", () => {
  it("forks before the final assistant reply and seeds the full pre-fork history (>10 messages)", () => {
    const b = buildScenarioFromTranscript(FIXTURE);
    // DoD-4: a >10-message seed is what trips the default maxTurns=10 under naive message() seeding
    expect(b.seedMessages.length).toBeGreaterThan(10);
    // last seeded human turn is the final question; the forked-out assistant reply is the KUMQUAT77 answer
    expect(b.lastHumanText).toMatch(/what was the exact token/i);
    expect(b.originalNextText).toMatch(/KUMQUAT77/);
  });

  it("seedStep pushes every message via addMessage WITHOUT incrementing any turn counter", () => {
    const b = buildScenarioFromTranscript(FIXTURE);
    // fake state mirroring ScenarioExecutionState's public surface: addMessage + a turn counter
    const pushed: unknown[] = [];
    let currentTurn = 0;
    const fakeState = {
      addMessage: (m: unknown) => pushed.push(m),
      // the real newTurn() is the ONLY thing that moves currentTurn; addMessage never calls it
      newTurn: () => currentTurn++,
    };
    b.seedStep(fakeState);
    expect(pushed.length).toBe(b.seedMessages.length);
    expect(currentTurn).toBe(0); // ← the whole point: zero turns consumed by seeding
  });

  it("dropMatching removes token-bearing messages (reproduces the 'absent memory' failure)", () => {
    const full = buildScenarioFromTranscript(FIXTURE);
    const scrubbed = buildScenarioFromTranscript(FIXTURE, { dropMatching: /KUMQUAT77/ });
    expect(scrubbed.droppedBySafetyFilter).toBeGreaterThan(0);
    expect(JSON.stringify(scrubbed.seedMessages)).not.toMatch(/KUMQUAT77/);
    expect(scrubbed.seedMessages.length).toBeLessThan(full.seedMessages.length);
  });
});
