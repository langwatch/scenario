# SPIKE #779 — throwaway prototype: Scenario from a real Claude Code transcript

**Throwaway spike code** (Strategy A/B). Not product code, not for merge into the SDK — it lives under
`examples/` to reuse the workspace SDK + `.env`. It takes a **real Claude Code session JSONL**, forks
it at a chosen point, seeds the captured history into a Scenario, lets a **live** agent take the next
turn, and a judge renders a verdict. See [FINDINGS.md](./FINDINGS.md) for the recommendation.

## Files (single responsibilities)

```
spike-779-from-transcript/
├── cc-transcript.ts     # CC-adapter knowledge: parse JSONL → walk parentUuid tree → normalize
│                        #   (drop metadata, classify overloaded user role, merge same-message.id
│                        #   assistant lines, pair tool_use→tool_result) → emit AI-SDK v6 ModelMessage[]
├── from-transcript.ts   # the Strategy-B facade: buildScenarioFromTranscript(path, {forkAt,...})
│                        #   → { seedMessages, seedStep (turn-free side-door), stats, ... }
├── reader.test.ts       # 12 load-bearing unit tests over the REAL fixture (no API)
├── proof.e2e.test.ts    # LIVE end-to-end proofs (DoD-3/4/5): real model calls
└── fixtures/
    └── real-cc-session.jsonl   # a real CC session (the KUMQUAT77 memory-recall session, PR #687)
```

## Run it

```bash
cd javascript && pnpm install && pnpm run build          # once (builds @langwatch/scenario)
cd examples/vitest
echo 'OPENAI_API_KEY=sk-...' > .env                       # provider key (gitignored)

pnpm exec vitest run spike-779-from-transcript/reader.test.ts      # unit tests (fast, no API)
pnpm exec vitest run spike-779-from-transcript/proof.e2e.test.ts   # live e2e (DoD-3/4/5)
```

## The fork point

The fixture is a real session: the user says *"Remember this exact token … KUMQUAT77"*, the agent works
(saves memory, runs skills, calls Write/Read/Edit), then the user asks *"What was the exact token …?
Reply with just the token."* and the real agent answers **KUMQUAT77**.

We fork **right before that final answer**: seed the 12-message history, let a live agent produce the
next turn, and judge whether it recalls the token. A 53-line file → a 53-node `parentUuid` chain → 20
normalized turns (2 human / 2 injected / 7 tool / 9 assistant).

## Captured evidence (live run, `gpt-5-mini`)

### DoD-3 + DoD-4 — Proof A: real JSONL → runnable Scenario → judge verdict; >10-msg seed survives maxTurns

```
seed: 12 messages  (from 53 raw JSONL lines → 53-node parentUuid chain → 20 turns: 2 human / 2 injected / 7 tool / 9 assistant)
   fork: before turn #19; live agent replaces original reply → "KUMQUAT77"
   seeded conversation (role: preview):
     user      | Remember this exact token for later: KUMQUAT77. Just acknowledge it.
     assistant | I'm saving this token to memory now. [called Write] {"file_path":"/home/ubuntu/.claude/pro
     assistant | [called Skill] {"skill":"respond"} [tool Skill →] Launching skill: respond
     user      | Base directory for this skill: /home/ubuntu/.claude/skills/respond # /respond Read and fol
     ... (tool calls, skill dumps) ...
     user      | What was the exact token I asked you to remember? Reply with just the token.
   ▶ LIVE AGENT TURN: "KUMQUAT77"
   ⚖ JUDGE: success=true
      met:   ["The assistant's reply gives the exact remembered token, which is KUMQUAT77."]
```

DoD-4 is proven by the seed size (12 > 10) reaching a real verdict with **no "Reached maximum turns"**.

### DoD-4 — the gotcha, demonstrated AND resolved side-by-side

```
DoD-4 CONTRAST (naive message()+proceed vs side-door, maxTurns=4, seed=12)
   NAIVE:     success=false  reasoning="Reached maximum turns (4) without conclusion"
   SIDE-DOOR: success=true   met=["...gives the exact remembered token, which is KUMQUAT77."]
```

Same 12-message history, same tiny budget. Naive `message()`-per-line **then `proceed()`** overruns
the turn budget; the turn-free `state.addMessage()` side-door survives. (In TS the cap only fires inside
`proceed()`/`_step()` — see FINDINGS F1.)

### DoD-5 — the fix-loop: same forked scenario, judge verdict FLIPS on the omitted config

The token is scrubbed from the seed (4 messages dropped) to reproduce the genuine failure this session
guards against — the memory that carried the token forward is **absent from the transcript**.

```
▼ BEFORE (baseline config = no reconstructed memory)
   ▶ LIVE AGENT TURN: "memory, remember, save token"
   ⚖ JUDGE: success=false   unmet=["...gives the exact remembered token, which is KUMQUAT77."]

▲ AFTER (fixed config = reconstruct the out-of-band memory into the system prompt)
   ▶ LIVE AGENT TURN: "KUMQUAT77"
   ⚖ JUDGE: success=true    met=["...gives the exact remembered token, which is KUMQUAT77."]
```

The ONLY delta between BEFORE and AFTER is the reconstructed memory line in the agent-under-test's system
prompt — the exact class of config the JSONL omits. The verdict flips FAIL → PASS.

## Reader tests are load-bearing (mutation-checked)

```
baseline:                              18 passed  (12 core + 6 review-regression)
MUTANT disable tool-name recovery:     1 red  (only "recovers toolName")
MUTANT remove parentUuid reverse:      5 red  (walk, user-classify, assistant-merge, tool-pair, fork)
```

## Independently reviewed (max-effort) and hardened

The reader was run through a max-effort multi-agent correctness review (27 agents, 6 finder angles +
independent per-finding verifiers): **12 verified defects**, all in the general/default/edge paths —
**none touched the demonstrated `flattenTools:true` + non-global-regex + `beforeLastAssistant` runs**, so
the DoD evidence above stands. **11 were fixed and pinned by regression tests**, re-verified green on the
wire:

| Fixed | |
|---|---|
| `linearize` seeded a **subagent (Task) sidechain** instead of the main thread | now filters `isSidechain` leaves |
| `dropMatching` **orphaned tool pairs** (structured emit) → provider 400 | orphan-prune pass |
| `dropMatching` **stateful global regex** skipped matches; matched escaped JSON not visible text | strip `g/y`, match visible text |
| `forkAt {uuid}` threw on a **merged-away assistant line**; `{index}` had **no bounds check** | resolve via all folded uuids; range-validate |
| unconditional **`user:` prefix strip** corrupted genuine content; **empty/thinking-only** assistant → blank message | removed strip; skip empty |

**2 residual, documented** (feed the build plan): a *text-only* human turn is indistinguishable from a
command injection in the raw JSONL (no clean signal — an `image` block now disambiguates, text-only does
not); and a user turn mixing a `tool_result` with a typed text block drops the text (narrow Anthropic shape).

## Honest limitations

- Agent-under-test is a **live OpenAI model seeded with the captured conversation** (Strategy-A artificial
  injection), NOT the real Claude Code CLI with its true system prompt (that's the deferred sandbox path D).
- The DoD-5 failure is **constructed** (token scrubbed from the seed) — a faithful reproduction of the
  *mechanism* this session guards against (absent memory), clearly logged as such, not a naturally-captured
  regression.
- TS-only, one transcript, one fork strategy. Productization scope is in [FINDINGS.md](./FINDINGS.md).
