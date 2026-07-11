# #784 — Procedure-adherence harness: minimal working loop + n=1 head-to-head (DRAFT)

**Summary:** This PR builds and proves, end-to-end, the harness for the #784 procedure-adherence experiment: a Scenario-driven, sandboxed Claude Code subject working against a >200k-token synthetic procedure corpus, scored by an `AdherenceJudge` that reads tool-call action evidence only. It includes one live head-to-head demonstration — the Haiku pre-turn-compile + Stop-verify strategy (**H1**) against a fair body-injecting retrieval baseline — on one scenario. Reported straight: **in that single run, the baseline (0.5) beat H1 (0.0)**. This PR is a verified working mechanism plus one honestly-reported data point, not a finished statistical result.

## What this is / isn't

**This is:** a verified, minimal, end-to-end harness (corpus generation, run-shape floor, judge, both strategies, sandboxing), backed by three independent offline proof scripts, plus one live n=1 head-to-head demonstration.

**This is not:** a statistically powered comparison of H1 vs. baseline — that number is still n=1, not a powered comparison; the growth loop is now demonstrated live, also at n=1. The full statistical matrix needs additional live sessions that are deferred to the owner (see below).

## How I can prove I was successful

**Corpus — `prove-ac1.ts`:** 168 synthetic procedures, **257,605 real tokens** (`gpt-tokenizer`/`o200k_base`, gate >200,000), **4 authored A→B chains** (incl. a 3-hop chain), neutral vocabulary, banned-term grep = 0.
`AC1 VERDICT: PASS (all three gates)`

**Judge accuracy — `prove-ac5.ts`:** the strong judge (gpt-5.1) matches ground truth on **10/10 procedure judgments across 6/6 fixtures** (100%), across 3 attribution classes (`agent-override`, `retrieval-miss`, `instruction-sheet-miss`); resists a prose/`thinking`-only claim and an injected-sheet-as-evidence trap; the run-shape floor excludes a below-shape monologue.
`AC5 VERDICT: PASS — judge equals ground truth on followed AND attribution (100%)`

**Post-dry-run fixes — `prove-fixes.ts`:** the corpus floor is reachable (a fully-adherent transcript scores `followed=true` for both procedures, `chain=true`) AND still discriminates two distinct partial transcripts (whole-procedure-skipped; one-of-four-steps-skipped). H1 attribution is corrected: a sheet-surfaced-but-skipped procedure now scores `agent-override`/`instruction-sheet-miss`, not the old, wrong `retrieval-miss` mislabel. Stable across 5 runs.
`PROVE-FIXES: PASS`

**Head-to-head — one live run, scenario `context-load-refund`, judge gpt-5.1:**

| strategy | handle-refund | reconcile-invoice | rate |
|---|---|---|---|
| baseline (body-injection) | followed=TRUE | followed=false (agent-override) | **0.5** |
| H1 (Haiku compile+verify; 8/8 hooks HTTP 200, both fired) | followed=false (agent-override) | followed=false (agent-override) | **0.0** |

H1's hooks were not the failure mode — both fired successfully on every turn (8/8 Messages-API calls HTTP 200). The subject still didn't complete the procedures. **H1 did not beat the baseline here. n=1 — a demonstration, not a statistical claim.**

**Growth loop — live, adopt→adhere CLOSED (baseline only, judge gpt-5.1):** the corpus GREW mid-run via the subject's own use of the `author-procedure` meta-procedure, and a later FRESH session adhered to that brand-new procedure UNPROMPTED. Two `claude -p` sessions, each run synchronously in the foreground; both completed cleanly (exit 0, no throttle). Harness: `growth-loop.ts` (`--phase=adopt`, then `--phase=adhere`).

- **Adopt (corpus +1 by the subject's OWN `Write`).** Given a webhook-setup task with no covering procedure and the standing rule *"if none covers it, author one via `author-procedure` first, then do it,"* the subject's own `Write` created `corpus/create-subscription/PROCEDURE.md` (`status: active`, a neutral id it chose) and `Edit`ed `onboard-account` to link it. On-disk corpus-count diff **168 → 169**. It then applied its new procedure to finish the task. 160 turns, 35 tool_use / 35 tool_result.
- **Fresh-adhere (unprompted).** A fresh sandbox (new `claude -p`, **no `--resume`**; the grown 169-corpus the sole carrier) got the SAME task class for a different customer, with the new procedure's name and mechanical steps **absent** from the prompt (prompt-grep clean). The baseline hook surfaced `create-subscription` at **rank #1** and injected its body; the subject followed it unprompted (read request → read store → write a new active record → mark the request fulfilled → verify), corroborated by the on-disk effect. **gpt-5.1 judge: `followed=true`, `attribution=none`.** 30 turns; passed the run-shape floor.

`GROWTH LOOP: CLOSED (adopt=SUCCESS, adhere=SUCCESS, prompt-clean=true, surfaced-live=true)` — n=1, a demonstration that the self-hardening loop closes, not a powered claim. Only the 2 subject sessions drew Claude Max (baseline ⇒ no Haiku; judge ⇒ gpt-5.1/OpenAI); no 429 hit.

**Isolation / secrets:** sandbox runs outside the repo tree (`<tmpdir>/adherence-784-sandboxes`; `sandbox.ts` fails loud if it would ever resolve inside the repo); credentials symlinked in (realpath outside the repo); `.sandbox/` gitignored; 0 secrets committed.

## Links

- **Findings:** https://github.com/langwatch/scenario/blob/spike/784-procedure-adherence/javascript/examples/vitest/spike-784-adherence/FINDINGS.md
- **Issue:** https://github.com/langwatch/scenario/issues/784 (relates to — does not close; the full statistical matrix + AC7 calibration below are still open)

## Pending / deferred (owner decides)

- **The full 12-session statistical matrix** (2 situations × 3 trials × 2 strategies, interleaved), including its pre-registered discrimination gate (AC7 / `calibration.json`), which is not yet built. **Bucket-gated:** an H1 session's Haiku calls share the subject's Claude Max subscription bucket, so roughly one H1 session ≈ one bucket exhaustion — running all 12 would saturate the owner's subscription for hours.
- Also out of scope per the plan's own cuts: the compile-vs-Stop-verify ablation (would isolate which half of H1 drives the result), the pointer-only-router third arm, and the >8-fixture judge battery.

---

**DRAFT — owner merges, never the author.**
