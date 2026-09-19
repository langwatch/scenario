/**
 * #779 — load-bearing unit tests for the CC transcript reader/adapter.
 * These run against a REAL Claude Code session JSONL (fixtures/real-cc-session.jsonl,
 * the KUMQUAT77 memory-recall session from the PR #687 work). No API calls.
 *
 * Each test pins a normalization that a naive "read top-to-bottom" transform gets wrong.
 * Mutation-checked: breaking the parentUuid walk, the same-id assistant merge, or the
 * tool_use→tool_result name recovery turns these red.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TextPart, ToolCallPart, ToolResultPart } from "ai";
import { describe, it, expect } from "vitest";
import {
  parseSessionFile,
  linearize,
  normalize,
  toModelMessages,
  type RawNode,
} from "./cc-transcript";
import { fromTranscript } from "./from-transcript";

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
    // no attachment node may surface in any normalized turn's source-uuid set (fails if filtering is off)
    expect(
      raw.filter((n) => n.type === "attachment").every((n) => !turns.some((t) => t.uuids.includes(n.uuid!)))
    ).toBe(true);
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
    // injected command/skill output dumps are injected user turns, NOT genuine human
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
    const toolMsg = msgs.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    const part = (toolMsg!.content as ToolResultPart[])[0];
    expect(part.type).toBe("tool-result");
    expect(typeof part.toolName).toBe("string");
    expect(part.output).toEqual(expect.objectContaining({ type: "text", value: expect.any(String) }));
  });

  it("emits assistant tool-call parts with input (v6), and drops thinking by default", () => {
    const msgs = toModelMessages(turns);
    const withToolCall = msgs.find(
      (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((p) => p.type === "tool-call")
    );
    expect(withToolCall).toBeTruthy();
    const call = (withToolCall!.content as Array<TextPart | ToolCallPart | ToolResultPart>).find(
      (p): p is ToolCallPart => p.type === "tool-call"
    );
    expect(call).toEqual(expect.objectContaining({ type: "tool-call", toolName: expect.any(String) }));
    expect(call).toHaveProperty("input");
    // thinking must NOT leak into the emitted messages by default (invalid for non-Anthropic models)
    const anyThinkingText = JSON.stringify(msgs).includes("[thinking]");
    expect(anyThinkingText).toBe(false);
  });

  it("flattenTools folds tool I/O into assistant TEXT (string content, reachable [tool …] marker)", () => {
    // flattenTools is the ONLY emit mode the e2e uses: tool_use/tool_result become readable
    // assistant TEXT (not structured parts) so a cross-model seed passes provider validation.
    const msgs = toModelMessages(turns, { flattenTools: true });
    // every message content is a plain string — NO structured tool parts survive
    expect(msgs.every((m) => typeof m.content === "string")).toBe(true);
    // no tool-role message survives; tool results are folded into assistant strings
    expect(msgs.some((m) => m.role === "tool")).toBe(false);
    // the trunc()'d tool-result marker path is reachable: an assistant string carries "[tool <name> …]"
    const marker = msgs.some(
      (m) => m.role === "assistant" && typeof m.content === "string" && /\[tool \S+ (?:→|ERROR)\]/.test(m.content)
    );
    expect(marker).toBe(true);
  });
});

describe("fromTranscript builder + DoD-4 turn-free seeding", () => {
  it("forks before the final assistant reply and seeds the full pre-fork history (>10 messages)", () => {
    const b = fromTranscript(FIXTURE);
    // A >10-message seed is what trips the default maxTurns=10 under naive message() seeding
    expect(b.seedMessages.length).toBeGreaterThan(10);
    // last seeded human turn is the final question; the forked-out assistant reply is the KUMQUAT77 answer
    expect(b.lastHumanText).toMatch(/what was the exact token/i);
    expect(b.originalNextText).toMatch(/KUMQUAT77/);
  });

  it("seedStep pushes every message via addMessage WITHOUT incrementing any turn counter", () => {
    const b = fromTranscript(FIXTURE);
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
    const full = fromTranscript(FIXTURE);
    const scrubbed = fromTranscript(FIXTURE, { dropMatching: /KUMQUAT77/ });
    expect(scrubbed.stats.droppedByMatch).toBeGreaterThan(0);
    expect(JSON.stringify(scrubbed.seedMessages)).not.toMatch(/KUMQUAT77/);
    expect(scrubbed.seedMessages.length).toBeLessThan(full.seedMessages.length);
  });
});

// Regression tests for the correctness bugs surfaced by the max-effort review (all previously green
// while broken — each fails on the pre-fix code).
describe("reader hardening (review regressions)", () => {
  it("linearize ignores subagent (Task) sidechains and walks the MAIN thread", () => {
    // main thread u1->a1 (leaf a1); a separate sidechain s1->s2 (leaf s2) appears later in file
    const nodes: RawNode[] = [
      { uuid: "u1", parentUuid: null, type: "user", message: { role: "user", content: "MAIN question" } },
      { uuid: "a1", parentUuid: "u1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "MAIN answer" }] } },
      { uuid: "s1", parentUuid: null, type: "user", isSidechain: true, message: { role: "user", content: "SUBAGENT task" } },
      { uuid: "s2", parentUuid: "s1", type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT chatter" }] } },
    ];
    const turns = normalize(linearize(nodes));
    expect(JSON.stringify(turns)).not.toMatch(/SUBAGENT/); // NOT the sidechain
    expect(turns.some((t) => /MAIN answer/.test(t.text ?? ""))).toBe(true);
  });

  it("dropMatching with a GLOBAL regex still scrubs every match (no stateful lastIndex skips)", () => {
    const g = fromTranscript(FIXTURE, { flattenTools: true, dropMatching: /KUMQUAT77/g });
    expect(JSON.stringify(g.seedMessages)).not.toMatch(/KUMQUAT77/);
  });

  it("structured-emit dropMatching leaves NO orphaned tool parts (provider-valid seed)", () => {
    const scrubbed = fromTranscript(FIXTURE, { dropMatching: /KUMQUAT77/ }); // default structured
    const callIds = new Set<string>();
    const resultIds: string[] = [];
    for (const m of scrubbed.seedMessages) {
      if (Array.isArray(m.content)) {
        for (const p of m.content as Array<TextPart | ToolCallPart | ToolResultPart>) {
          if (p.type === "tool-call") callIds.add(p.toolCallId);
          if (p.type === "tool-result") resultIds.push(p.toolCallId);
        }
      }
    }
    expect(resultIds.every((id) => callIds.has(id))).toBe(true); // every result has its call
  });

  it("forkAt {index} out of range throws instead of silently mis-forking", () => {
    expect(() => fromTranscript(FIXTURE, { forkAt: { index: -2 } })).toThrow(/out of range/);
    const n = fromTranscript(FIXTURE).stats.normalizedTurns;
    expect(() => fromTranscript(FIXTURE, { forkAt: { index: n + 5 } })).toThrow(/out of range/);
  });

  it("forkAt {uuid} resolves a uuid pointing at a merged-away (non-first) assistant line", () => {
    // fdf12fbd… is the text line of the first assistant message (merged into the af3e4e11 turn)
    const b = fromTranscript(FIXTURE, { forkAt: { uuid: "fdf12fbd-a1a9-43f0-98b4-0c67c50a1a45" } });
    // resolves to the turn that folded that (non-first) line in — NOT throw "not found", NOT index 0
    expect(b.turns[b.stats.forkTurnIndex].uuids).toContain("fdf12fbd-a1a9-43f0-98b4-0c67c50a1a45");
  });

  it("pruneOrphanToolParts prunes an orphaned tool-CALL when the fork drops its tool_result", () => {
    // The fixture only orphans tool-RESULTs; this synthesizes the mirror case (an orphaned tool-CALL).
    // Chain: user → assistant(tool_use T1) → tool_result(T1) → assistant(text). Forking BEFORE the
    // tool_result turn seeds the tool_use with no matching result → the tool-call part must be pruned.
    const nodes: RawNode[] = [
      { uuid: "u1", parentUuid: null, type: "user", message: { role: "user", content: "run the tool" } },
      { uuid: "a1", parentUuid: "u1", type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "T1", name: "Foo", input: {} }] } },
      { uuid: "t1", parentUuid: "a1", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "T1", content: "ok" }] } },
      { uuid: "a2", parentUuid: "t1", type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
    ];
    const dir = mkdtempSync(join(tmpdir(), "sc779-orphan-call-"));
    const path = join(dir, "synthetic.jsonl");
    writeFileSync(path, nodes.map((n) => JSON.stringify(n)).join("\n"));

    // turns: 0 user, 1 assistant(tool_use T1), 2 tool(result T1), 3 assistant(text) → fork before #2
    const b = fromTranscript(path, { forkAt: { index: 2 } });

    // the orphan-tool-CALL branch fired…
    expect(b.stats.prunedOrphanToolParts).toBeGreaterThan(0);
    // …and no tool-call part remains whose id lacks a matching tool-result
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of b.seedMessages) {
      if (Array.isArray(m.content)) {
        for (const p of m.content as Array<TextPart | ToolCallPart | ToolResultPart>) {
          if (p.type === "tool-call") callIds.add(p.toolCallId);
          if (p.type === "tool-result") resultIds.add(p.toolCallId);
        }
      }
    }
    expect([...callIds].every((id) => resultIds.has(id))).toBe(true);
  });

  it("does not strip a leading 'user: ' from genuine human content", () => {
    const turns = normalize(linearize(parseSessionFile(FIXTURE)));
    const firstHuman = turns.find((t) => t.role === "user" && t.userKind === "human")!;
    // the fixture's real content begins with "user: Remember…" — that prefix must survive verbatim
    expect(firstHuman.text?.startsWith("user: ")).toBe(true);
  });
});
