# SPIKE #779 — Findings & recommendation: a runnable Scenario from a real Claude Code transcript

> Scope (owner steer 2026-07-10): **adapter-specific, JSONL-sourced.** Source = the Claude Code
> adapter's native session JSONL, NOT LangWatch traces (Strategy C, deferred). This doc records the
> spike's recommendation, the source-fidelity verdict, the findings the prototype surfaced, a build
> plan, and the deferral list. The full 4-strategy taxonomy lives in the issue body; this doc does
> not restate it — it commits to one path and reports what running the code actually taught us.

## TL;DR

- **Recommendation: Strategy A now → productize as B.** Prototyped end-to-end, live, on a real CC
  session. A (script-injection replay) needs **zero SDK changes**; B (`fromTranscript()` on the CC
  adapter) is A with the sharp edges moved inside a supported API.
- **Source fidelity: raw JSONL wins**, decisively, for both the CC use case and the general case —
  and the prototype *demonstrates the reason*: the JSONL carries the conversation but **not the
  config that shaped it** (system prompt / CLAUDE.md / memory / guardrails), and that omission is
  exactly what flips the agent's behaviour on replay.
- **Posture on the root-CLAUDE.md problem: start artificial (context-injection), escalate to sandbox
  only for failures artificial replay can't reproduce.** The prototype is the artificial end and it
  already reproduces + fixes a real failure mode.
- **All 7 DoD items met with live evidence.** See [PROTOTYPE.md](./PROTOTYPE.md) for the run.

---

## DoD-1 — Recommendation (primary strategy + rejected ones)

| Strategy | Verdict | Why |
|---|---|---|
| **A — script-injection replay** | ✅ **Adopt now** | Zero SDK change. Seed captured history via the turn-free `state.addMessage()` side-door, hand the fork point to a live `agent()`, `judge()` the next turn. Proven live. |
| **B — `fromTranscript()` on the CC adapter** | ✅ **Productize** | A, with the reader + Anthropic→SDK adapter + seed/fork API turned into a tested module instead of hand glue. The prototype IS the B shape (`from-transcript.ts`), just under `examples/`. |
| **C — from LangWatch traces** | ⛔ **Deferred (owner steer)** | Cross-adapter generalization only. Loses on source fidelity (below). Not pursued. |
| **D — full-sandbox deterministic re-exec** | ⛔ **Deferred** | Heavy (config materialization + untrusted-replay sandboxing). Escalate to it only for failures artificial replay cannot reproduce. |

**Position on artificial-vs-sandbox:** land **artificial** first. It is cheap, needs no CLAUDE.md
reconstruction, and is *good enough to iterate on "does this change move the behaviour."* The
prototype's fix-loop (DoD-5) shows a config change flipping the judge verdict without ever
reconstructing Claude Code's real system prompt. Sandbox (D) is the fidelity escalation, reserved for
failures the artificial path can't reproduce — not a co-equal option for this spike.

## DoD-2 — Source-fidelity verdict: raw JSONL vs LangWatch traces

**Raw JSONL wins for the CC first use case AND for the general production-agent case.** The schema is
not the limiter; the **ingestion pipeline** is. Evidence:

| Signal | Raw CC JSONL | LangWatch traces |
|---|---|---|
| **System prompt / CLAUDE.md** | ❌ absent in BOTH (verified: no `systemPrompt`/`claudeMd` in any `~/.claude/projects/*.jsonl`) | ❌ absent, **plus** whole role categories permanently privacy-dropped |
| **Extended thinking** | ✅ **captured** (prototype fixture has thinking blocks of 297 / 483 / 835 / 225 chars) | ❌ Anthropic redacts reasoning; never stored |
| **Tool I/O** | ✅ full, untruncated, id-paired | ⚠️ 64KB IO preview + offload; ~60KB source-side cap inside CC before LangWatch sees it |
| **Structure** | ✅ one ordered file, `parentUuid` tree | ⚠️ one session = many traces (one per turn); needs re-linearize + re-correlate |
| **Truncation layers** | 0 | 5 stacked (privacy drop, 64KB preview, visibility-window teaser, ~60KB CC body cap, thinking redaction) |

The prototype makes the headline finding concrete: **the JSONL does not contain the system prompt**,
yet replay works — because the agent-under-test supplies its *own* config, and reconstructing the
omitted config (memory, guardrail framing) out-of-band is what makes the replay faithful or fixes it.

## DoD-6 — Build plan for the productized `fromTranscript` path

Each step names the prototype file that already implements it (port `examples/…` → `src/…`).

1. **Transcript-reader module** — `src/adapters/claude-code/transcript/reader.ts`
   Port `cc-transcript.ts` (parse → `parentUuid` walk → normalize: drop metadata, classify overloaded
   `user` role, merge same-`message.id` assistant lines, pair `tool_use`→`tool_result`). Study/port the
   normalization realities already encoded in `langwatch/.../claude-code-log-to-span.ts` (it targets the
   lossy OTel stream; reuse the *logic*, keep our fuller JSONL source).
2. **Anthropic → AI-SDK v6 message adapter** — `src/adapters/claude-code/transcript/to-model-messages.ts`
   Port `toModelMessages`. **Load-bearing decisions the prototype settled:** (a) `thinking` dropped by
   default (invalid to feed non-Anthropic models; opt-in `includeThinking`); (b) `flattenTools` for
   cross-model seeds — structured `tool-call`/`tool-result` parts trip provider validation when replayed
   into a *different* model family than produced them.
3. **Seed / prefill executor API** — formalize the `state.addMessage()` side-door as a first-class,
   documented `seed?: ModelMessage[]` param on `run()` / the constructor. It writes straight to
   `state.messages` and never touches `currentTurn`, so a long history costs zero turn budget. (TS:
   `scenario-execution-state.ts:89`; the run loop enforces `maxTurns` only inside `_step()`/`proceed()`,
   `scenario-execution.ts:846` — see finding F1.)
4. **Fork-point API** — `forkAt: { uuid | index | timestamp | beforeLastAssistant }`. Prototyped in
   `from-transcript.ts`; the forked-out "next" turn is retained for criteria generation.
5. **Criteria generation** — the retained original next-turn is the candidate "mistake." Productize as
   LLM-summarize-the-divergence → **human-confirm** (never auto-accept). Prototype hard-codes the criterion.
6. **Security note (mandatory before D):** replaying a captured session **re-issues its tool calls**
   (file writes, shell). Any move toward sandbox/exact-replay (Strategy D) must sandbox untrusted replay.
   The artificial path (A/B) sidesteps this by only re-running the *model*, never the transcript's tools.

## New findings the prototype surfaced (not in the issue body)

- **F1 — the max_turns gotcha is a *Python* behaviour; TS differs.** In TS, `maxTurns` is enforced
  ONLY inside `_step()` (the `proceed()` auto-advance loop, `scenario-execution.ts:846`), not during
  explicit script steps. So a fully-scripted `message()×N + agent() + judge()` run does **not** die even
  when N ≫ maxTurns (observed: 12 msgs, maxTurns=4, success). The real trap is `message()×N` **then
  `proceed()`** — `proceed`'s first `_step` sees the budget already spent → *"Reached maximum turns."*
  The side-door seed avoids it under either shape. Both shapes are demonstrated live (DoD-4).
- **F2 — `message({role:"user"})` requires a registered USER agent** or the executor throws
  *"no agent with this role was found."* The side-door has no such requirement.
- **F3 — cross-model tool linkage.** Feeding a Claude session's structured `tool-call`/`tool-result`
  parts into an OpenAI agent-under-test trips provider-side validation. `flattenTools` (fold tool I/O
  into readable assistant text) is the robust artificial-injection emit; keep structured emission for
  same-family replay.
- **F4 — the agent's guardrails are config too, and they're absent from the JSONL.** With a plain
  "helpful assistant" prompt, `gpt-5-mini` **refused** to recall the token ("can't help with secrets").
  A minimal harness-appropriate system prompt reproduced the original success. Another facet of the crux:
  behaviour on replay depends on config the transcript never captured.

## DoD-7 — Explicit deferral list (out of scope for this spike)

- **Strategy C (from-traces / LangWatch-thread source).** Deferred per owner steer; documented as the
  eventual cross-adapter generalization. The reader interface is shaped so a trace source can drop in later.
- **Strategy D (full sandbox / exact deterministic re-execution)** incl. CLAUDE.md-at-SHA reconstruction,
  config isolation, and untrusted-replay sandboxing.
- **Criteria auto-generation productization** (the LLM-summarize-the-divergence heuristic — prototype
  hard-codes the criterion).
- **Python-SDK parity** (prototype is TS-only, matching the CC adapter's TS-only home).
- **A UI / a `langwatch`-app trace-ingestion pipeline.**
- **Bit-exact deterministic replay** of a non-deterministic agent (the goal is reproducing the failure
  often enough to iterate — N-run judging — not determinism).

## What was verified, and how

Everything above marked ✅ is backed by a **live run** on a real CC session
(`fixtures/real-cc-session.jsonl`, the KUMQUAT77 memory-recall session from PR #687). Reproduce with the
command in [PROTOTYPE.md](./PROTOTYPE.md). Reader normalizations are pinned by 18 unit tests, shown
load-bearing by two mutations (disabling tool-name recovery → 1 red; removing the `parentUuid` reverse
→ 5 red).

The reader was then hardened against a **max-effort multi-agent correctness review** (12 verified
defects — all in general/default/edge paths, none in the demonstrated runs): **11 fixed + regression-
tested**, 2 documented as residual. Details and the fix table are in [PROTOTYPE.md](./PROTOTYPE.md) §
"Independently reviewed." Those fixes ARE the transcript-reader hardening that step DoD-6.1 calls for —
port the hardened code, not a fresh naive parser.
