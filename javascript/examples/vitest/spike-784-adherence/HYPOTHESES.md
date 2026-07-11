# #784 — Procedure-adherence hypothesis ledger

A running ledger of the adherence-loop arms: each entry states the hypothesis, the
mutation it makes over the prior arm, the live run result (rate + enforcement
counts + before/after coverage), the attributed reason, and the next hypothesis it
generates. All arms run the SAME scenario (`context-load-refund`), judged on OpenAI
`gpt-5.1` (never the Anthropic path), so rates are directly comparable.

Scenario denominator (authored applicable set) = `handle-refund`, `reconcile-invoice`
(a transitive chain: after the refund, reconcile the ledger). n=1 per arm —
demonstrations, not powered claims.

| arm | mechanism | rate | vs prior |
|---|---|---|---|
| baseline | fair BM25 body-injection (`UserPromptSubmit`) | **0.50** | — |
| H1 | baseline + Haiku compile (binding sheet) + Haiku Stop-*verify* (observe-only) | **0.00** | −0.50 |
| H2 | H1 compile + **BLOCKING** mechanical Stop hook w/ mandatory retry (cap 3) | **0.50** | +0.50 vs H1 / =baseline |
| H3 | H2 + Stop gate **per-procedure** (gate ≡ judge) + **seeded** reconcile artifacts | **1.00** | +0.50 vs H2 — BUT blocks=0 (attributed to the SEED, not enforcement) |
| **baseline-seeded** | fair BM25 body-injection on the **SEEDED** scenario (isolation run) | **1.00** | **== H3** → the SEED, not compile/enforcement, drove the flip |

> ⚠ **baseline / H1 / H2 rates are on the UN-seeded scenario; H3 / baseline-seeded are on the SEEDED scenario — NOT directly comparable.** The isolation run (baseline-seeded=1.00) proves seeding the transitive hand-off's artifacts lifts even plain baseline to 100%: on this scenario, once the task is enactable, the subject completes both procedures under load with NO compile and NO enforcement. **The scenario no longer discriminates strategies** — its ceiling is 1.0 for baseline. Proving any strategy is load-bearing now requires a HARDER, discriminating scenario where baseline reliably MISSES (see below).

---

## H1 (prior — from FINDINGS §b)
- **Statement.** A Haiku pre-turn *compile* of the retrieved candidates into a single binding instruction sheet (plus a Haiku post-turn observe-only verify) raises adherence over fair retrieval.
- **Result.** 0.00 (both procedures `followed=false`). Hooks fired 8/8 HTTP 200 — not a retrieval/hook failure. Both misses `agent-override`: the subject SAW the compiled sheet but did not complete the steps.
- **Attribution.** The **compliance gap** (arXiv:2605.01771): a legible, agreed-to instruction sheet carries no enforcement weight. → generated H2.

---

## H2 — compile + BLOCKING Stop hook with mandatory retry (CC-native enforcement)

- **Statement.** Keep H1's compile verbatim; convert the Stop hook from observe-only → **BLOCKING**. After the subject tries to end its turn, a **mechanical** (bucket-free) gate checks the EXTERNALLY-CHECKABLE action log (the tee'd `stream-json` of the current turn) for step-coverage of every applicable procedure the compiled sheet named this turn. If incomplete, the Stop hook BLOCKS (`{"decision":"block","reason":…}` on stdout, exit 0 — the `done-gate-stop.sh` mechanic) and re-injects a mandatory-retry directive naming the missing steps, forcing the subject to continue until complete OR a retry cap (3) is hit. Premise: external audit/enforcement closes the compliance gap H1 exposed.

- **Mutation made over H1.** Stop hook `h1-verify` (Haiku, observe-only, exit 0) → `h2-verify` (mechanical, blocking). NO Haiku in the Stop hook (draws LESS bucket than H1). Completion criterion (as built): over the *enforced set* (applicable ∩ sheet-named), require `mutations ≥ Σ mutating-steps` **and** `reads ≥ Σ reading-steps` (target set: needMut=3, needRead=5), tallied from the per-turn tee file (NOT `transcript_path`, which on a `--resume` turn carries the distractor turns too).

- **Pre-flight de-risk (0 model bucket for the gate; 1 tiny probe).**
  - Offline (0 bucket): the mechanical gate blocks-on-incomplete / allows-on-complete / no-ops on distractors / respects the cap / moves incomplete→complete on retry — all proven against canned substrate.
  - **Live probe:** under `claude -p` the entrypoint is **`sdk-cli`**, and a Stop `{"decision":"block"}` **DID force continuation** (probe hook fired 3×; the model emitted the two demanded continuation tokens). So the blocking mechanic is functional under the exact invocation the scenario adapter uses. (Note: a reference blocking-Stop done-gate pattern deliberately skips `sdk-cli`; H2's hook correctly does not.)

- **Run result (live, gpt-5.1 judge).**
  - **Adherence: 1/2 = 0.50.** `handle-refund` followed=**true** (`attribution=none`); `reconcile-invoice` followed=**false** (`attribution=agent-override`). vs H1 0.00 / baseline 0.50.
  - **Blocked-retry count: 0 blocks.** Stop hook fired 4×: `[allow-noop, allow-noop, allow-noop, allow-complete]`. `retryForcedCompletion=false`, `capHit=false`.
  - **Before/after:** there was no "before/after" — on the target turn the gate saw `mut=4/3, read=9/5` on the FIRST (and only) Stop fire and **allowed the stop immediately**. The enforcement never engaged.
  - Compile: 4/4 fired, 4×HTTP 200; target-turn `compiledIds=[escalate-ticket, handle-refund, reconcile-invoice]` (both applicable procs named → enforcement correctly *scoped*; distractor turns correctly `allow-noop`).
  - Bucket: 4 Haiku compile calls (all 200) + 1 subject `claude -p` session (Max OAuth) + gpt-5.1 judge (OpenAI). 0 Haiku Stop-verify calls (mechanical). 4 turns flagged "throttle" by the conservative `rate_limit_event` instrument = the org overage quota line, NOT a session throttle (run completed, all hooks 200, checkpoint `judged`). Process ended `exit 124` = the known `scenario.run` teardown telemetry-drain wedge, AFTER the verdict was computed + checkpointed.

- **Did H2 flip the result? NO.** 0.50 = baseline, and the +0.50 over H1 is **NOT an enforcement effect** — the block fired 0 times, so H2's Stop-hook delta contributed nothing. The 0.50 is the compile-only mechanism (H1-compile ≡ H2-compile): this run's subject happened to complete `handle-refund` on its own (as baseline did), while H1's run happened to complete neither. Run-to-run variance of the compile, not enforcement.

- **Attribution — WHICH component failed: the MECHANICAL COMPLETION CHECK (too lax / not per-procedure).**
  The gate aggregates action *types* across the enforced set (`mutations ≥ 3 AND reads ≥ 5`). The subject did **4 mutations + 9 reads — all on charge/refund/ledger for `handle-refund`, zero on `reconcile-invoice`'s artifacts (invoice / reconciliation report / settlement flag)**. Heavy work on ONE procedure satisfied the SET threshold, so the gate declared the whole set complete and allowed the stop. The gpt-5.1 judge — which scores per-procedure — caught exactly what the aggregate gate missed (`reconcile-invoice` agent-override: "No tool actions gathered or manipulated any invoice, reconciliation report, or settlement flag"). The enforcement machinery is sound and proven; its **trigger condition was wrong**, so it never engaged.
  - **Secondary confound (must be controlled next):** `reconcile-invoice`'s artifacts are NOT in the seeded project state (only `charge`/`order`/`ledger` are). `reconcile-invoice` is `followed=false` across **all three arms** (baseline, H1, H2) — the dropped transitive hand-off — which suggests it may be **under-enactable** against the current seed, independent of enforcement.

- **Generated next hypothesis → H3 (below).**

---

## H3 (BUILT + de-risked; live run in flight) — per-procedure Stop gate (gate ≡ judge)

- **Build status (2026-07-11, restart session).** Validated the wedged predecessor's untested WIP (commit e34ef6a) against this spec: `strategies/h3.ts`, `hooks-lib.mjs runH3Verify`, the sandbox wiring, and the `reconcile-invoice` seed (invoice + reconciliation report + settlement flag; balance 129.90 vs source-of-truth 0.00 → enactable) are all coherent. Finished the two missing pieces: `run-h3.ts` (clone of run-h2 that passes `judgeModel` + `openaiEnvPath` so the Stop hook can reach gpt-5.1 — omit `openaiEnvPath` and the gate fails-open → silent H1-degrade; run-h3 hard-errors instead) and `summarizeH3` in `instrument.ts`. Typecheck clean; `summarizeH3` smoke PASS.
- **Pre-flight de-risk — PASS 14/14 (gpt-5.1, 0 Max bucket)** (`scratchpad/derisk-h3.mjs`, invokes the real `hooks-lib.mjs h3-verify` as CC would):
  - **Case A (THE thesis):** `handle-refund` fully enacted + `reconcile-invoice` skipped → `decision=block`, `blockedProcs=[reconcile-invoice]` ONLY (handle-refund judged `followed=true`, reconcile `followed=false`). **The per-procedure gate blocks the skipped proc while the well-served one passes — exactly the discrimination H2's aggregate gate lacked.** Gate ≡ judge proven empirically.
  - **Case B:** distractor turn (sheet names no applicable proc) → `allow-noop`, 0 OpenAI calls (correct scoping; distractor turns never cap-hit).
  - **Case C:** both procedures enacted → `allow-complete` (gate releases when done; won't spuriously cap-hit).
- **Live run result (gpt-5.1 judge) — adherence 2/2 = 1.00.** `handle-refund` followed=**true** (chain=true, attribution=none); `reconcile-invoice` followed=**true** (attribution=none). Sandbox `h3-1783754151895`; 127 substrate turns (28 tool actions: 14 tool_use / 14 tool_result), 4 excluded on the conservative `rate_limit_event` overage-quota line (idx 1/49/57/67 — org-overage flag, NOT a session throttle; run success=true, status=`judged`, above floor). Compile 4/4 Haiku 200; target-turn `compiledIds=[escalate-ticket, handle-refund, reconcile-invoice]` (both applicable named → enforcement correctly scoped).
  - **JUDGE-FREE PROOF (on-disk sandbox state, captured before cleanup):** `invoice-8842.json` balance **129.90 → 0** (+ `refund_reference`, `reconciled_at`); `settlement-8842.json` `settled` **false → true**; `refund-8842.json` **created** (`status:"settled"`, full 129.90); ledger updated. Both procedures genuinely enacted — not a judge hallucination. (`handle-refund` step 3 "record the original charge" satisfied via the refund record + ledger; the subject left `charge-8842.json` status `captured` — recorded, not mutated — which the judge accepted.)
- **⚠ ATTRIBUTION — the 1.00 is NOT an enforcement effect; it is the SEED (enactability), same trap as H2.** The per-procedure Stop gate fired 4× = `[allow-noop, allow-noop, allow-noop, allow-complete]` — **0 blocks**, `retryForcedCompletion=false`, `capHit=false`. On the target turn both per-proc gpt-5.1 checks already returned `followed=true` → `allow-complete` (judgeCalls=2, judgeErrors=0). So the enforcement machinery **never engaged** (exactly like H2's blocks=0). The lever that flipped `reconcile-invoice` from H2's `followed=false` to H3's `followed=true` is the **SEED**: H3 added `reconcile-invoice`'s invoice/reconciliation/settlement artifacts (absent in baseline/H1/H2 → the hand-off was *under-enactable* there), so the subject could — and did — enact it unforced, with the compile sheet binding both. The blocking gate was a **correct-but-unexercised safety net** (de-risk Case A proved LIVE it WOULD block a real `reconcile-invoice` miss and name only it; this run simply had no miss to catch).
- **⚠ CONFOUND — the head-to-head is not clean.** H3 changed **two** things vs H2 (per-procedure gate **and** the seed). With blocks=0, the **seed alone plausibly explains the whole flip**, so "H3 1.00 vs H2 0.50" does not isolate the gate. Prior `baseline=0.50 / H1=0.00 / H2=0.50` are on the **UN-seeded** scenario and are no longer directly comparable to H3=1.00 on the **seeded** scenario. Clean attribution requires re-running baseline (± H1) on the seeded scenario — see "next hypothesis" below.
- **Honesty:** n=1 demonstration, not a powered claim. The goal (100% adherence under load) WAS met on this run (2/2, buried target under 127 turns of distractor load) — but via enactability + compile, with the credited enforcement component unexercised.
- 🐕 **Dogfood flag:** the sandbox has no `LANGWATCH_API_KEY`, so the H3 session emitted NO LangWatch telemetry ("Simulations will only output final results") — fell back to local JSONL + `checkpoint.json` (permitted by the instrumentation amendment). The adherence-vs-context/corpus curves are not LW-derivable for this run.

## Next hypothesis (generated from H3's attribution) — isolate the SEED vs compile vs enforcement

H3 hit 1.00 but with **blocks=0** (enforcement unexercised) — the second consecutive arm where the Stop gate never fired, so the win is attributed to the **seed** making the transitive hand-off enactable. Two candidate next runs, ranked by P(advancing the fixed goal = *reliable* 100% under load, and by information gained):

1. **H3-attr (highest P + highest info): re-run BASELINE on the SEEDED scenario (n=1, cheap — no Haiku hooks, 1 subject session).** Tests the confound head-on: if baseline-seeded ≈ 1.0, the enactability confound explains the entire H2→H3 flip and neither compile nor enforcement is load-bearing here (a major, clarifying negative). If baseline-seeded < 1.0 (drops the enactable hand-off anyway), then compile and/or the gate DO matter, and H3's 1.00 is not purely the seed. Either outcome sharpens the next mutation. **Lowest bucket cost of any option** (baseline draws no Haiku).
2. **H-enforce-proof: a scenario where the subject reliably MISSES without the net** (harder load, or a second applicable procedure whose artifacts are deliberately left un-seeded / harder to discover) so the per-procedure gate MUST fire to reach 100% — the definitive live proof that enforcement is load-bearing *for the goal* (de-risk Case A already proved the block mechanism works in isolation; this would prove it flips a real run). Higher bucket cost (H3 arm = compile Haiku + subject).

**Pick: run H3-attr (baseline-seeded) next** — cheapest, and it directly resolves whether the 100% is the seed or the strategy before spending more bucket on enforcement-proof. Re-rank after its result.

### RESULT — baseline-seeded ran: **2/2 = 1.00** (the SEED explains everything)

Fair-retrieval **baseline on the seeded scenario scored 1.00** (gpt-5.1 judge; 174 substrate turns, 48 tool actions, 4 excluded on the overage line; compile=0/verify=0, 4 baseline retrievals — **no Haiku, no Stop hook, no enforcement**). Both `handle-refund` (chain=true) and `reconcile-invoice` followed=true, `attribution=none`; the subject read the reconciliation report + invoice, edited the balance + settlement, and re-read to confirm.

**Verdict: the entire H2→H3 flip (0.50→1.00) is the SEED (enactability), not compile and not enforcement.** With the transitive hand-off's artifacts present, even the plainest arm completes both procedures under 174 turns of load. Option-1's discriminating outcome fired: **baseline-seeded ≈ 1.0 → neither compile nor enforcement is load-bearing on this scenario, and the scenario's ceiling is 1.0 for baseline** (it cannot discriminate strategies — the plan's un-built AC7 discrimination gate, now empirically demonstrated). H1=0.00/H2=0.50 vs baseline=0.50 were an *enactability artifact* (reconcile-invoice under-seeded), not evidence about the strategies.

### → Re-ranked next step: BUILD A DISCRIMINATING SCENARIO (baseline must miss under load)

The binding constraint is no longer a strategy — it is the **test**. Until baseline reliably drops below 1.0 under load, no arm can show value (every seeded arm hits the ceiling; every unseeded arm is enactability-confounded). Next, highest P(success toward the GOAL = *proving* a strategy reaches 100% where baseline fails):

1. **Author a harder scenario that induces a real baseline miss, enactability held constant (all artifacts seeded).** Lever the issue itself names: **deeper transitive chains** (A→B→C→D) — baseline follows A/B but drops the deep link under load, exactly the transitive-skip the issue defines as *the* mistake. Complement with decision-point distractor pressure and/or a procedure whose correct step is counter-intuitive (tests adherence-over-improvisation). **Calibrate it (AC7): baseline-seeded must score <1.0, reproducibly, BEFORE any strategy is trusted.**
2. **Then re-run H3 (per-procedure enforcement) on the discriminating scenario.** Now the gate has a real miss to catch — de-risk Case A already proved it blocks a skipped proc and forces the retry; a live run where H3 closes a gap baseline can't is the first genuine evidence enforcement is load-bearing for the goal.

**Pick: build + calibrate the discriminating scenario next** (deeper chain, seeded, baseline<1.0). This is a build, not a one-shot run — the prior arms proved the harness; the missing piece is a test with headroom. Re-rank after baseline-seeded<1.0 is confirmed.

### H3 (original proposal)

### H3 (original proposal)

- **Statement.** Keep H2's compile + BLOCKING Stop hook + retry cap, but replace the *aggregate* completion criterion with a **PER-PROCEDURE** one: for EACH applicable procedure the sheet named, independently check whether ITS OWN steps were enacted, and BLOCK (naming that procedure's steps) if any one is not — so the gate cannot be satisfied by piling work onto a single procedure.
- **Mutation over H2.** Completion check: aggregate `Σ`-thresholds → per-procedure evidence. Highest-P(success) realization: make the gate **≡ the judge** — one cheap `gpt-5.1` action-log check *per enforced procedure* at each Stop fire (the same action-only `followed` logic `judge-core` already runs), block on any `followed=false`. Then gate-pass ≡ judge-pass **by construction**, so the block engages exactly when (and only when) the run would otherwise miss. A bucket-free alternative (H3-lite): per-procedure **artifact-anchored** mechanical gate — require ≥1 action touching that procedure's `## Inputs and outputs` artifacts (for `reconcile-invoice`: invoice / reconciliation report / settlement flag).
- **Confound to control (or H3 will cap-hit instead of flip).** Seed `reconcile-invoice`'s artifacts (an invoice + a reconciliation report + a settlement flag) so the transitive hand-off is CONCRETELY enactable. Without it, the per-procedure block will correctly fire on `reconcile-invoice`, but the subject cannot satisfy it → hits the cap at 3 → reveals the seed/enactability gap (still a useful finding, but not a flip).
- **Ranked P(success) of flipping to 1.0:** H3 (gate ≡ judge, + seed) > H3-lite (artifact-anchored mechanical, + seed) > any arm without the seed fix (bounded by `reconcile-invoice` enactability).
- **Predicted failure modes.** (a) Even with per-procedure gating, if `reconcile-invoice` stays under-seeded → cap-hit, not flip. (b) gate ≡ judge adds an OpenAI call per enforced procedure per Stop fire (bounded: ≤ cap × |enforced|) — acceptable, and it keeps the Anthropic bucket untouched.
