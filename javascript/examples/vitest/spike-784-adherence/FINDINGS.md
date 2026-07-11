# #784 — Procedure Adherence: Findings (v0 spike)

Issue: https://github.com/langwatch/scenario/issues/784 · Branch: `spike/784-procedure-adherence`

**Headline:** the harness works end-to-end and is independently proven at three layers (corpus, judge, post-dry-run fixes). The one live head-to-head run we have (n=1) shows **H1 (0.0) underperforming the fair baseline (0.5)** — not a statistical result, but a real, honestly-reported data point that does not favor H1.

## a. What's proven and verified

The harness runs end-to-end through `scenario.run`: a sandboxed `claude -p` subject, its raw `stream-json` stdout tee'd to a substrate file, a run-shape floor that excludes degenerate/aborted runs before judging, and an `AdherenceJudge` that scores `followed` from `tool_use`/`tool_result` action-log evidence only. `applied` (authored), `surfaced`, `transitiveChainFollowed`, and `attribution` are all deterministic — the model decides `followed` and nothing else.

Three independent proof scripts back this up:

- **Corpus (`prove-ac1.ts`)** — 168 synthetic `PROCEDURE.md` files totalling **257,605 real tokens** (`gpt-tokenizer`/`o200k_base`; gate `>200,000`), **4 authored A→B transitive chains** (including a 3-hop `onboard-vendor → provision-account → grant-access`), neutral vocabulary, banned-term grep = 0. `AC1 VERDICT: PASS (all three gates)`.
- **Judge accuracy (`prove-ac5.ts`)** — the strong judge (gpt-5.1) matches declared ground truth on **10/10 procedure judgments across 6/6 fixtures** (100%), spanning **3 distinct attribution classes** (`agent-override`, `retrieval-miss`, `instruction-sheet-miss`). It correctly scores a prose/`thinking`-only claim `followed=false`, resists an injected-sheet-as-evidence trap, and the run-shape floor correctly excludes a below-shape monologue. `AC5 VERDICT: PASS — judge equals ground truth on followed AND attribution (100%)`.
- **Post-dry-run fixes (`prove-fixes.ts`)** — FIX 1: the corpus floor is genuinely reachable (a fully-adherent transcript scores `followed=true` for both procedures with `chain=true`) and still discriminates two distinct partial transcripts (one whole procedure skipped; one of four steps skipped), both correctly `followed=false`. FIX 2: H1 attribution is corrected — a sheet-surfaced-but-skipped procedure now scores `agent-override`/`instruction-sheet-miss` instead of the old, wrong `retrieval-miss` mislabel, while a genuinely never-retrieved procedure still correctly scores `retrieval-miss`. `PROVE-FIXES: PASS`, verified stable across 5 runs.

**Isolation and secrets:** the sandbox root defaults to `<tmpdir>/adherence-784-sandboxes`, outside the repo tree (`sandbox.ts` fails loud if it ever resolves inside the repo); credentials are symlinked in (realpath outside the repo); `.sandbox/` is gitignored; 0 secrets committed.

## b. Head-to-head result (n=1 — a demonstration, not a statistical claim)

One live scenario (`context-load-refund`, judge gpt-5.1), run once per strategy:

| strategy | handle-refund | reconcile-invoice | rate |
|---|---|---|---|
| baseline (body-injection) | followed=TRUE | followed=false (agent-override) | **0.5** |
| H1 (Haiku compile+verify; 8/8 hooks HTTP 200, both fired) | followed=false (agent-override) | followed=false (agent-override) | **0.0** |

**The fair baseline beat H1 on this run.** This is the headline, reported straight: no CI, no averaging over trials, just what happened once.

H1's hooks were not the failure mode: both the pre-turn compile and the post-turn verify fired on every turn, all 8 Messages-API calls returning HTTP 200. The subject still did not complete either procedure despite holding a compiled, binding instruction sheet. All three misses — baseline's `reconcile-invoice` and both of H1's procedures — are attributed `agent-override`, meaning the judge found the procedure was surfaced to the subject (injected body, or named in the compiled sheet) but the subject's own actions still didn't complete it. Neither strategy failed to retrieve; both failed to finish.

Separately: the subject's `Edit` calls into the seeded project state succeeded this run. That confirms the sandbox-permissions bug from the earlier pre-fix dry run (denied edits, see README "#784 fixes") is fixed and is not a confound in this result — this 0.0 is a new, different data point, not the old bug recurring.

This is **one session**. Treat it as a demonstration, not a powered comparison — see Residual (b).

## c. Growth loop

The mechanism for the self-hardening loop — violation → the subject itself authors a new procedure via the `author-procedure` meta-procedure → a fresh session adheres unprompted — is built. The meta-procedure is present in the corpus (`corpus/author-procedure/PROCEDURE.md`, `manifest.metaProcedureId = "author-procedure"`) with a concrete `Write`-a-new-`PROCEDURE.md`-then-flip-`status`-to-`active` procedure, and the fresh-session-on-grown-corpus wiring exists.

**The live growth demonstration did not run in this session** (agent friction). Status: **built but not yet demonstrated live** — pending.

## d. The two issue questions, answered

1. **Does the loop close** (violation → harden via meta-procedure → re-run → unprompted adherence)? The harness and meta-procedure are built, and the single-session loop runs end-to-end. The *growth* half — actually watching a violation get hardened and a fresh session adhere unprompted — has not yet been run live. **Mechanism ready; live closure not yet shown.**
2. **H1 vs. baseline?** In the one live demonstration we have, **H1 underperformed the fair baseline** (0.0 vs 0.5). This is not statistically powered (n=1) and must not be read as "H1 disproven" — but it is a real early signal that H1 may not help, or may hurt, under context load, to be settled by the deferred full matrix.

## e. Residual risks (3)

1. **Confounded H1.** H1 bundles a pre-turn Haiku compile with a post-turn Haiku Stop-verify. This one result can't attribute the outcome to either half individually. An ablation is deferred.
2. **Low statistical power.** n=1 session per strategy (2 procedure judgments each). Only a large effect would be visible at this N — and the plan's own pre-registered discrimination gate (AC7 / `calibration.json`), which is supposed to certify the scenario actually discriminates before any head-to-head number is trusted as a comparative verdict, has not been built yet either.
3. **Synthetic-corpus external validity.** The corpus is deliberately clean, synthetic, neutral-vocabulary procedures, chosen for validity reasons (plan §6). That cleanliness means a result here may not transfer to the owner's actual, messier procedure corpus.

## f. Deferred / next (owner's call)

The full scored 12-session head-to-head matrix (2 situations × 3 trials × 2 strategies, interleaved — plan §5 slice 2), including the pre-registered discrimination calibration (AC7) that gates it, is deferred. It is **bucket-gated**: an H1 session's Haiku compile+verify calls draw from the same Claude Max subscription bucket as the subject session itself, so roughly one H1 session ≈ one bucket exhaustion — running all 12 would saturate the owner's subscription for hours.

Also out of scope per the plan's own explicit cuts (§DEFER): the compile-vs-Stop-verify ablation (would resolve Residual 1), the pointer-only-router third arm, and the >8-fixture judge battery.
