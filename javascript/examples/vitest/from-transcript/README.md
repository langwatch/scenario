# `fromTranscript` — a runnable Scenario from a real Claude Code transcript (#779)

Point this helper at a real Claude Code session log (`~/.claude/projects/<slug>/<session>.jsonl`),
fork it at the moment the agent is about to take a turn, and get a **runnable Scenario** seeded with
that captured history — then let a **live** agent-under-test take the next turn and a **judge** assert
whether it reproduces (or fixes) the original behaviour.

This is the [#779](https://github.com/langwatch/scenario/issues/779) **Strategy B** shape
(adapter-specific, JSONL-sourced). It graduates the [#789](https://github.com/langwatch/scenario/pull/789)
spike into a small, tested helper. It is **not** the productionized feature — no general UI, no
trace-ingestion pipeline. Scope is locked to the Claude Code JSONL path; the from-traces (Strategy C)
and full-sandbox (Strategy D) paths are deferred (see the issue).

## Why this is non-trivial

A Claude Code session JSONL is **not** a flat message list. It is an append log threaded as a **tree**
via `parentUuid`/`uuid`, and the reader must handle four things a naive top-to-bottom read gets wrong:

1. **Walk the `parentUuid` chain** leaf→root (then reverse), not file order — editing/re-running a turn
   creates sibling branches, and subagent (`Task`) sidechains are appended after the main thread.
2. **`role:"user"` is overloaded** — a line is *either* a genuine human turn *or* a `tool_result`
   carried as a user message (the sample fixture: 2 real human turns vs 7 tool_results). They must be
   distinguished.
3. **One assistant message is split across many JSONL lines** (one per `thinking`/`text`/`tool_use`
   block, all sharing one `message.id`) — these must be re-merged into a single assistant turn.
4. **Anthropic blocks → AI-SDK v6 `ModelMessage`** — `tool_use`/`tool_result`/`thinking` map onto a
   different native shape; `tool_result` carries only an id, so the tool **name** is recovered by
   pairing back to its `tool_use`.

## The `max_turns` seeding gotcha (and the fix)

Seeding captured history via `message()`/`user()`/`agent()` script steps **silently consumes the shared
`maxTurns` budget** (default 10). A ~15-message transcript then dies with *"Reached maximum turns"* the
moment a `proceed()` runs. This helper seeds through the **turn-free `state.addMessage()` side-door**
(`seedStep`), which writes straight to `state.messages` and never touches `currentTurn` — so a seed of
any length costs zero budget. (In the TS SDK the cap is only enforced inside `_step()` /
`proceed()`, `scenario-execution.ts:846` — confirmed.)

## Usage

```ts
import scenario from "@langwatch/scenario";
import { fromTranscript } from "./from-transcript";

// 1. Convert a real CC session → a seeded Scenario (fork defaults to "before the last assistant reply").
const seed = fromTranscript("/path/to/session.jsonl", {
  forkAt: { beforeLastAssistant: true }, // or { uuid } | { index }
  flattenTools: true,                    // fold tool I/O into text when the agent-under-test is a
                                         // different model family than the transcript's source
});

// 2. Drop the seed straight into a normal scenario.run(): side-door seed → live agent() → judge().
const result = await scenario.run({
  name: "replay: <the failure you are reproducing>",
  description: "Replay of a captured Claude Code session; the live agent takes the forked turn.",
  maxTurns: 10,                          // seed does NOT consume this — it is side-door seeded
  agents: [myAgentUnderTest, scenario.judgeAgent({ criteria: ["…what the agent must / must not do…"] })],
  script: [seed.seedStep, scenario.agent(), scenario.judge()],
});
```

`fromTranscript(path, opts)` returns a `SeededScenario` — `{ seedMessages, seedStep, lastHumanText,
originalNextText, turns, stats, … }`. It has **no dependency on the scenario SDK**, so the reader and
converter stay unit-testable without spinning up a run (see `reader.test.ts`).

### Options

| option | meaning |
|---|---|
| `forkAt` | `{ uuid }` \| `{ index }` \| `{ beforeLastAssistant: true }` (default) — where to cut the history |
| `flattenTools` | fold `tool_use`/`tool_result` into assistant **text** (robust cross-model seed; avoids provider 400s on cross-family structured tool linkage) |
| `includeThinking` | emit captured `thinking` (default `false` — feeding Anthropic reasoning to a non-Anthropic model is invalid) |
| `dropMatching` | scrub seed messages matching a `RegExp` — used to reproduce an "absent config/memory" failure |

## The end-to-end demo

`proof.e2e.test.ts` runs the whole loop **live** (real model calls, not mocked) against
`fixtures/real-cc-session.jsonl` — a **PII-scrubbed** real Claude Code memory-recall session (the
`KUMQUAT77` token is a synthetic placeholder that grants nothing; every tool_result / attachment /
injected-skill body and tool-call input was reduced to a placeholder so no real operator memory or infra
ships in this public repo — the parentUuid tree, tool structure, thinking, and recall flow stay intact):

- **Proof A** — faithful full-history replay: the ~15-message seed (which would trip a naive
  `maxTurns`) is side-door seeded, the live agent answers the user's final question, and the judge
  returns a real verdict.
- **max_turns contrast** — the same history seeded the naive way (`message()`×N then `proceed()`) hits
  the turn cap, while the side-door seed under the same budget reaches a verdict.
- **Proof B (fix-loop)** — the token is scrubbed from the seed; the judge verdict **flips FAIL→PASS**
  on nothing but the one config the JSONL omits (the reconstructed memory in the agent's system prompt).

### Run it

```bash
cd javascript && pnpm install && pnpm run build      # build the SDK → dist/
cd examples/vitest && pnpm install
pnpm exec vitest run from-transcript/reader.test.ts                  # unit tests — no API keys needed
# live e2e — gated behind SC779_LIVE (skipped by default so CI's example suite needs no funded key):
printf 'OPENAI_API_KEY=sk-...\nLANGWATCH_API_KEY=sk-lw-...\n' > .env  # LANGWATCH key optional (adds a live report URL)
SC779_LIVE=1 pnpm exec vitest run from-transcript/proof.e2e.test.ts
# to run against Gemini instead of the OpenAI default:  SC779_LIVE=1 SC779_PROVIDER=gemini pnpm exec vitest run …
```

## Honest caveat (the crux)

The Claude Code JSONL captures the **conversation** (messages, tool I/O, thinking, timestamps) but
**not the config that shaped it** — the injected CLAUDE.md, agent profile, tool schemas, and
system-reminders are absent. So this is Strategy-A "artificial context injection": you seed the live
agent with the captured *conversation* and observe whether a prompt/tool/procedure change moves the next
response. It is strong enough to iterate on "does this change flip the behaviour" (Proof B does exactly
that), and deliberately weaker than a claim of "bit-exact what Claude Code would have done" — that is the
deferred sandbox path (Strategy D).
