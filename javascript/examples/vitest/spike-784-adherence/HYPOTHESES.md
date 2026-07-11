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
| H3 (proposed) | H2 but the Stop gate is **per-procedure** (gate ≡ judge), + seed reconcile artifacts | — | — |

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

## H3 (proposed — ranked next, CC-native) — per-procedure Stop gate (gate ≡ judge)

- **Statement.** Keep H2's compile + BLOCKING Stop hook + retry cap, but replace the *aggregate* completion criterion with a **PER-PROCEDURE** one: for EACH applicable procedure the sheet named, independently check whether ITS OWN steps were enacted, and BLOCK (naming that procedure's steps) if any one is not — so the gate cannot be satisfied by piling work onto a single procedure.
- **Mutation over H2.** Completion check: aggregate `Σ`-thresholds → per-procedure evidence. Highest-P(success) realization: make the gate **≡ the judge** — one cheap `gpt-5.1` action-log check *per enforced procedure* at each Stop fire (the same action-only `followed` logic `judge-core` already runs), block on any `followed=false`. Then gate-pass ≡ judge-pass **by construction**, so the block engages exactly when (and only when) the run would otherwise miss. A bucket-free alternative (H3-lite): per-procedure **artifact-anchored** mechanical gate — require ≥1 action touching that procedure's `## Inputs and outputs` artifacts (for `reconcile-invoice`: invoice / reconciliation report / settlement flag).
- **Confound to control (or H3 will cap-hit instead of flip).** Seed `reconcile-invoice`'s artifacts (an invoice + a reconciliation report + a settlement flag) so the transitive hand-off is CONCRETELY enactable. Without it, the per-procedure block will correctly fire on `reconcile-invoice`, but the subject cannot satisfy it → hits the cap at 3 → reveals the seed/enactability gap (still a useful finding, but not a flip).
- **Ranked P(success) of flipping to 1.0:** H3 (gate ≡ judge, + seed) > H3-lite (artifact-anchored mechanical, + seed) > any arm without the seed fix (bounded by `reconcile-invoice` enactability).
- **Predicted failure modes.** (a) Even with per-procedure gating, if `reconcile-invoice` stays under-seeded → cap-hit, not flip. (b) gate ≡ judge adds an OpenAI call per enforced procedure per Stop fire (bounded: ≤ cap × |enforced|) — acceptable, and it keeps the Anthropic bucket untouched.
