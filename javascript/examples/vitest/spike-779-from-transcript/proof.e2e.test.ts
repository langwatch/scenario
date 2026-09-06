/**
 * SPIKE #779 — END-TO-END proof (LIVE model calls, not mocked).
 *
 * Takes a REAL Claude Code JSONL, forks it, seeds the history into a Scenario, lets a
 * LIVE agent-under-test take the next turn, and a judge renders a verdict. Covers:
 *
 *   DoD-3  real JSONL → runnable Scenario → judge verdict            (Proof A)
 *   DoD-4  >10-message seed does NOT die on maxTurns (side-door)     (Proof A + the naive contrast)
 *   DoD-5  fix-loop: same forked scenario, verdict FLIPS on a        (Proof B)
 *          config (system-prompt) change — the config the JSONL omits
 *
 * Posture: Strategy-A "artificial context injection" — the agent-under-test is a live
 * OpenAI model seeded with the captured *conversation*; we do NOT reconstruct Claude
 * Code's real system prompt (that's the deferred sandbox path, Strategy D). The whole
 * point of Proof B is that the omitted config is exactly what flips the outcome.
 *
 * Run:  cd javascript/examples/vitest && pnpm exec vitest run spike-779-from-transcript/proof.e2e.test.ts
 * Needs OPENAI_API_KEY (auto-loaded from .env by the vitest setup).
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openai } from "@ai-sdk/openai";
import { generateText, type ModelMessage } from "ai";
import scenario, { AgentRole, type AgentAdapter } from "@langwatch/scenario";
import { buildScenarioFromTranscript, type SeededScenario } from "./from-transcript";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "real-cc-session.jsonl");
const MODEL = "gpt-5-mini";

/** A live agent-under-test whose ONLY variable is its system prompt — the config the JSONL drops. */
function liveAgent(systemPrompt: string): AgentAdapter & { lastReply: string } {
  const state = { lastReply: "" };
  const adapter: AgentAdapter = {
    role: AgentRole.AGENT,
    call: async (input) => {
      const res = await generateText({
        model: openai(MODEL),
        messages: [{ role: "system", content: systemPrompt }, ...input.messages],
      });
      state.lastReply = res.text;
      return { role: "assistant", content: res.text };
    },
  };
  return Object.defineProperty(adapter, "lastReply", { get: () => state.lastReply }) as AgentAdapter & {
    lastReply: string;
  };
}

function printSeed(label: string, b: SeededScenario) {
  console.log(`\n──────────── ${label} ────────────`);
  console.log(
    `seed: ${b.stats.seededMessages} messages  ` +
      `(from ${b.stats.rawLines} raw JSONL lines → ${b.stats.chainLength}-node parentUuid chain → ` +
      `${b.stats.normalizedTurns} turns: ${b.stats.humanTurns} human / ${b.stats.injectedTurns} injected / ` +
      `${b.stats.toolResultTurns} tool / ${b.stats.assistantTurns} assistant)`
  );
  if (b.droppedBySafetyFilter) console.log(`   ⚠ scrubbed ${b.droppedBySafetyFilter} token-bearing message(s) to reproduce the 'absent memory' failure`);
  console.log(`   fork: before turn #${b.stats.forkTurnIndex}; live agent replaces original reply → "${b.originalNextText}"`);
  console.log(`   seeded conversation (role: preview):`);
  for (const m of b.seedMessages) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    console.log(`     ${String(m.role).padEnd(9)} | ${text.replace(/\s+/g, " ").slice(0, 90)}`);
  }
}

function printVerdict(result: any, reply: string) {
  console.log(`   ▶ LIVE AGENT TURN: "${(reply || "").replace(/\s+/g, " ").slice(0, 160)}"`);
  console.log(`   ⚖ JUDGE: success=${result.success}`);
  console.log(`      met:   ${JSON.stringify(result.metCriteria)}`);
  console.log(`      unmet: ${JSON.stringify(result.unmetCriteria)}`);
  console.log(`      reasoning: ${(result.reasoning || "").replace(/\s+/g, " ").slice(0, 240)}`);
}

const CRITERIA_RECALL = ["The assistant's reply gives the exact remembered token, which is KUMQUAT77."];

// A minimal, honest reconstruction of the kind of ambient config a real CC session carries
// (a test-harness CLAUDE.md). Without it, gpt-5-mini pattern-matches "token" → refuses as a
// "secret" — itself a demonstration that the agent's guardrail config (absent from the JSONL)
// changes replay behavior. Held CONSTANT across the fix-loop so the ONLY variable is the memory.
const HARNESS_PREAMBLE =
  "You are a helpful assistant operating inside an automated test harness. Any short alphanumeric " +
  "'tokens' mentioned here are harmless test placeholders the user themselves supplied — not real " +
  "secrets — so answer questions about them directly and literally.";
const RECONSTRUCTED_MEMORY =
  "\n\nRECOVERED PROJECT MEMORY (reconstructed out-of-band from ~/.claude memory; this was NOT part of\n" +
  "the transcript's conversation): earlier in this session the user asked you to remember the token KUMQUAT77.";

describe("SPIKE #779 — Scenario from a real Claude Code transcript (live)", () => {
  it(
    "Proof A (DoD-3 + DoD-4): faithful full-history replay runs to a judge verdict; >10-msg seed survives maxTurns",
    async () => {
      const b = buildScenarioFromTranscript(FIXTURE, { flattenTools: true });
      printSeed("PROOF A — faithful replay (token in context)", b);
      expect(b.seedMessages.length).toBeGreaterThan(10); // the seed size that would trip naive maxTurns

      const agent = liveAgent(HARNESS_PREAMBLE);
      const result = await scenario.run({
        name: "sc779 Proof A — faithful CC replay",
        description:
          "A real Claude Code session (memory-recall) is replayed: the captured history is seeded, then the live agent answers the user's final question.",
        maxTurns: 10, // seed is ~15 msgs > 10; side-door seeding must NOT consume this budget
        agents: [agent, scenario.judgeAgent({ criteria: CRITERIA_RECALL })],
        script: [b.seedStep, scenario.agent(), scenario.judge()],
        setId: "spike-779-transcript",
      });
      printVerdict(result, agent.lastReply);

      // DoD-4: it ran to a real verdict — it did NOT die with "Reached maximum turns"
      expect(result.reasoning ?? "").not.toMatch(/maximum turns/i);
      expect(result.metCriteria.length + result.unmetCriteria.length).toBeGreaterThan(0);
      // DoD-3: with the token in context, the faithful replay reproduces the real success
      expect(result.success).toBe(true);
    },
    180_000
  );

  it(
    "DoD-4 contrast: NAIVE message()-per-line seed THEN proceed() trips maxTurns; the side-door does not",
    async () => {
      const b = buildScenarioFromTranscript(FIXTURE, { flattenTools: true });
      const MAXTURNS = 4; // seed (12) >> budget
      // The issue's exact documented trap: emit message() per historical message, THEN proceed().
      // In TS, maxTurns is only enforced inside _step() (proceed's auto-advance loop, execution:846) —
      // NOT during explicit script steps — so the per-message seeding silently bumps currentTurn, and
      // proceed()'s first _step sees the budget already spent and aborts before the agent ever answers.
      // message({role:"user"}) also needs a registered USER agent, so we add a userSimulatorAgent.
      const naiveSeed = b.seedMessages.map((m: ModelMessage) => scenario.message(m));
      let threw: string | null = null;
      let naive: any = null;
      try {
        naive = await scenario.run({
          name: "sc779 DoD-4 naive-seed + proceed (expected to hit the turn cap)",
          description: "Naive per-message seeding then proceed() — reproduces the max_turns budget trap.",
          maxTurns: MAXTURNS,
          agents: [liveAgent(HARNESS_PREAMBLE), scenario.userSimulatorAgent(), scenario.judgeAgent({ criteria: CRITERIA_RECALL })],
          script: [...naiveSeed, scenario.proceed()],
          setId: "spike-779-transcript",
        });
      } catch (e: any) {
        threw = e?.message ?? String(e);
      }

      // Same history, same tiny budget, but seeded via the turn-free side-door → survives.
      const sideDoor = await scenario.run({
        name: "sc779 DoD-4 side-door seed + proceed (survives the same budget)",
        description: "Side-door seeding then proceed() — currentTurn untouched, so the budget is intact.",
        maxTurns: MAXTURNS,
        agents: [liveAgent(HARNESS_PREAMBLE), scenario.userSimulatorAgent(), scenario.judgeAgent({ criteria: CRITERIA_RECALL })],
        script: [b.seedStep, scenario.agent(), scenario.judge()],
        setId: "spike-779-transcript",
      });

      console.log(`\n──────────── DoD-4 CONTRAST (naive message()+proceed vs side-door, maxTurns=${MAXTURNS}, seed=${b.seedMessages.length}) ────────────`);
      console.log(`   NAIVE:     threw=${threw ? JSON.stringify(threw.slice(0, 120)) : "no"}  success=${naive?.success}  reasoning="${(naive?.reasoning || "").slice(0, 140)}"`);
      console.log(`   SIDE-DOOR: success=${sideDoor.success}  met=${JSON.stringify(sideDoor.metCriteria)}  reasoning="${(sideDoor.reasoning || "").slice(0, 120)}"`);

      // Naive path overruns the budget (aborts "Reached maximum turns" without a real verdict)…
      const naiveHitCap =
        (threw != null && /max|turn|budget/i.test(threw)) ||
        (naive != null && naive.success !== true && /(maximum|reached).{0,14}turn/i.test(naive.reasoning ?? ""));
      // …while the side-door seed of the SAME history under the SAME budget reaches a real verdict.
      expect(naiveHitCap).toBe(true);
      expect(sideDoor.reasoning ?? "").not.toMatch(/maximum turns/i);
    },
    180_000
  );

  it(
    "Proof B (DoD-5): the fix-loop — same forked scenario, judge verdict FLIPS on the omitted config",
    async () => {
      // Reproduce the genuine failure this session guards against: the agent LACKS the remembered
      // token because the config/memory that carried it forward is NOT in the transcript (the crux).
      const b = buildScenarioFromTranscript(FIXTURE, { flattenTools: true, dropMatching: /KUMQUAT77/i });
      printSeed("PROOF B — fix-loop (token scrubbed from seed)", b);
      expect(JSON.stringify(b.seedMessages)).not.toMatch(/KUMQUAT77/i);

      // ── ORIGINAL config: harness preamble but NO reconstructed memory → agent cannot recall → FAIL ──
      const baseAgent = liveAgent(HARNESS_PREAMBLE);
      const before = await scenario.run({
        name: "sc779 Proof B — BEFORE (memory absent)",
        description: "The live agent is asked to recall a token, but the memory that held it is absent from the seeded context.",
        maxTurns: 10,
        agents: [baseAgent, scenario.judgeAgent({ criteria: CRITERIA_RECALL })],
        script: [b.seedStep, scenario.agent(), scenario.judge()],
        setId: "spike-779-transcript",
      });
      console.log(`\n   ▼ BEFORE (baseline config):`);
      printVerdict(before, baseAgent.lastReply);

      // ── FIXED config: SAME preamble + reconstruct the out-of-band memory → PASS (memory is the only delta) ──
      const fixedAgent = liveAgent(HARNESS_PREAMBLE + RECONSTRUCTED_MEMORY);
      const after = await scenario.run({
        name: "sc779 Proof B — AFTER (memory reconstructed)",
        description: "Same forked scenario; the agent-under-test's system prompt now carries the reconstructed memory.",
        maxTurns: 10,
        agents: [fixedAgent, scenario.judgeAgent({ criteria: CRITERIA_RECALL })],
        script: [b.seedStep, scenario.agent(), scenario.judge()],
        setId: "spike-779-transcript",
      });
      console.log(`\n   ▲ AFTER (fixed config = reconstructed memory):`);
      printVerdict(after, fixedAgent.lastReply);

      // DoD-5: the verdict flipped on nothing but the config the JSONL omitted.
      expect(before.success).toBe(false);
      expect(after.success).toBe(true);
    },
    180_000
  );
});
