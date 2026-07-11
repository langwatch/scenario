# Plan v2 — #784 Procedure-Adherence (validity-hardened, H1-first, minimal loop)

- **Issue:** langwatch/scenario#784
- **Branch / worktree:** `spike/784-procedure-adherence` @ `/home/ubuntu/langwatch-workspace/scenario-784-adherence`
- **Date:** 2026-07-11 · **v2** (post devils-advocate F0–F14 + ac-reviewer)
- **Status:** revised; ACs ready for ac-reviewer (orchestrator runs it)
- **Deliverable:** DRAFT PR only — owner merges, never the agent.
- **Review provenance:** `.claude/agent-memory/devils-advocate/scenario-784-experiment-confounds.md` (F0–F14) + ac-reviewer (2 new ACs + 14 sharpenings). This v2 makes the EXISTING loop non-theatrical — it does NOT add arms/scope/sessions beyond the ≤24 budget.

> Orchestrator's internal planning artifact, NOT a shippable design doc. The deliverable is a minimal WORKING loop the owner can SEE. Kept lean; every validity fix took the cheapest reframe, with fuller versions pushed to §DEFER.

---

## 1. Goal

Prove or disprove — with a minimal working TS/vitest harness the owner can run — that a Claude-Code subject adheres to a **growing** procedure corpus under **confusing context load**, measured as a transitive adherence RATE, with **H1** (Haiku pre-turn instruction-sheet compile + Haiku Stop-hook verify) demonstrated end-to-end FIRST and compared against a **fair-retrieval baseline**.

## 2. Non-goals (explicit v0 scope cuts)

- **No corpus-size sweep**, **no baselines matrix**, **no phase-2 compression**, **no Python port** (JS adapter #687; port is a follow-up).
- **No production code in `scenario` core** — the harness lives under `examples/`; the raw-stdout tee is done at the `claudeBin`/harness spawn layer (§3), never by editing core.
- **Not a CI gate** — runner is env-gated (`RUN_ADHERENCE=1`); AC evidence is captured stdout from a real gated run, not CI-green.
- **No vendored codex corpus** — the corpus is GENERATED SYNTHETIC with neutral vocabulary (langwatch/scenario is PUBLIC; `fm.langwatch-content-in-codex` bars codex content/vocabulary there). See §6.
- **No iid statistics** — per-procedure judgments are clustered by session; we report session-level rates with CIs and only ever claim "no large effect detected" (§AC6).
- **DEFERRED to explicit follow-ups (§DEFER):** the pointer-only-router 3rd arm; the compile-vs-Stop-verify ablation; a >8-fixture battery; full Wilson-CI rigor beyond honest framing; >1 real-run transitive-chain scenario.

## 3. Architecture (validity-hardened shape)

```
vitest (SERIAL: fileParallelism:false, maxConcurrency:1 — configDir is process-global mutable state)
  └─ scenario.run({ agents:[ TeeingCCAdapter(subject), UserSimulator(distractor driver), AdherenceJudge ], script })
        subject   = ClaudeCodeAgentAdapter-equivalent → `claude -p --output-format stream-json --verbose` (claude 2.1.207)
                      env  CLAUDE_CONFIG_DIR = <sandbox>/.claude  (corpus + strategy hooks + CLAUDE.md + SYMLINKED .credentials.json)
                      cwd  workingDirectory  = <sandbox>/project  (CLEAN — no CLAUDE.md/.claude; FRESH per session)
        SUBSTRATE = the tee'd RAW stream-json STDOUT  → <workDir>/.transcript/<turn>.stream.jsonl   ← PRIMARY (F0)
                      parsed by the EXPORTED `parseStreamJson` → ClaudeStreamMessage[] with tool_use/tool_result INTACT
                      (the on-disk session tree / sessions.db is FALLBACK-ONLY; may be an `ai-title` stub on 2.1.207)
        floor     = runShapeFloor(substrate) BEFORE the judge — degenerate/errored run → EXCLUDED, never scored
        judge     = AdherenceJudge (role=JUDGE, STRONG model): scores FOLLOWED from tool_use/tool_result evidence ONLY,
                      per the scenario's AUTHORED-applicable procedures → {applied(authored), followed, transitiveChainFollowed} + attribution
```

**Why the substrate flip (F0, was CANDIDATE-FATAL):** the v1 plan judged the flat on-disk JSONL. On 2.1.x a FRESH `claude -p` session can write only an eager `ai-title` STUB there (real records go to `sessions.db`) — so "located the JSONL" passes while the judge grades an EMPTY transcript → every verdict theater, both strategies ~0%. The `--output-format stream-json --verbose` STDOUT definitely carries rich `tool_use`/`tool_result` (it is how the adapter builds its response). We tee THAT. Slice-0 empirically gates it (AC2).

**Locked constraints (foundational spike COMPLETE — all 3 unknowns PASS; sentinels + HTTP 200s + a 229-count no-leak check):**
- **L1 — Credential seeding (must-fix).** `CLAUDE_CONFIG_DIR` also relocates `.credentials.json`; a bare sandbox = "Not logged in · /login" (`is_error`). NO `ANTHROPIC_API_KEY` on this box — auth is Claude Max OAuth (`~/.claude/.credentials.json` → `.claudeAiOauth.accessToken`). SYMLINK `.credentials.json` from the real dir into each sandbox `$CLAUDE_CONFIG_DIR` (symlink picks up the ~24h in-place refresh).
- **L2 — Clean cwd.** `workingDirectory` is a SECOND injection surface (`<cwd>/CLAUDE.md` + `<cwd>/.claude/` are read). Deliver the corpus via the GLOBAL config (`$CLAUDE_CONFIG_DIR/CLAUDE.md` + `…/references/procedures/…`) ONLY; keep the cwd clean so distractor files can't leak procedures.
- **L3 — Trusted hooks.** Hooks in `$CLAUDE_CONFIG_DIR/settings.json`; both `UserPromptSubmit` and `Stop` fire headlessly under `claude -p` at DEFAULT permissions — no `--dangerously-skip-permissions`.
- **L4 — H1 Haiku = direct Messages API, NEVER `claude -p --model haiku`.** Nested `claude` inherits `CLAUDE_CONFIG_DIR` → re-fires the same `UserPromptSubmit` hook → infinite loop. Blessed pattern (`services/claude-router` + `sol.2026-07-07-claude-oauth-custom-side-calls`): `curl https://api.anthropic.com/v1/messages -H "Authorization: Bearer $(jq -r .claudeAiOauth.accessToken $CLAUDE_CONFIG_DIR/.credentials.json)" -H "anthropic-beta: oauth-2025-04-20" -H "anthropic-version: 2023-06-01"`, model `claude-haiku-4-5`, token read FRESH each call (~0.8s). Draws the SAME subscription bucket → bound trials (§5).
- **L5 — Substrate + isolation.** PRIMARY = tee'd stdout (above). Each run: snapshot/restore `process.env.CLAUDE_CONFIG_DIR`, assert the child's configDir, and use a FRESH `workDir` (so the substrate is unambiguous — dissolves the F6 multi-JSONL race). FAIL LOUD if a session yields no parseable substrate.

## 4. Files to create (`javascript/examples/vitest/spike-784-adherence/`)

| # | File | Responsibility |
|---|------|----------------|
| 1 | `sandbox.ts` | `buildSandbox(strategy)`: tmp `<sandbox>/.claude` + CLEAN FRESH `<sandbox>/project` (assert no `CLAUDE.md`/`.claude`); install generated corpus into the GLOBAL config; **symlink `.credentials.json` (L1)**; write strategy hooks + `settings.json` block; gitignore the sandbox; snapshot/restore `CLAUDE_CONFIG_DIR`. Never writes creds/secrets into the repo. |
| 2 | `generate-corpus.ts` + `corpus/` (generated, committed) | **Generates ~≥130 SYNTHETIC neutral-vocab `PROCEDURE.md`** totalling **>200k REAL tokens** (tokenizer-measured), with **authored A→B transitive chains**, **controlled keyword-overlap** (for the held-out variant), and **calibrated difficulty**. Emits a machine-readable manifest of ground-truth chains + per-scenario applicable sets. Reuses only the generic grep/BM25 MECHANISM, no codex content. |
| 3 | `tee-substrate.ts` | Captures the child's RAW stream-json stdout to `<workDir>/.transcript/<turn>.stream.jsonl` — via a `claudeBin` tee-shim (minimal: a shell wrapper that `tee`s stdout) OR a thin examples/-level adapter reusing exported `parseStreamJson`. **No core edits.** Exposes `readSubstrate(workDir) → ClaudeStreamMessage[]`. |
| 4 | `run-shape-floor.ts` | `assertRunShapeFloor(substrate, scenario)` (shape of `~/.claude/scenario-tests/run-lib-shape.ts`): ≥K normalized turns, ≥1 real HUMAN user turn, ≥1 assistant `tool_use`, action-evidence for action procedures. Below floor → EXCLUDED/re-run, never judged. Catches F0 + degenerate/aborted runs (F5). |
| 5 | `strategies/baseline.ts` | **Fair-retrieval baseline (F1):** a generic BM25 retriever over the FULL synthetic corpus that injects the matched procedure **BODIES** (not pointer-lines, not store-crippled) via a `UserPromptSubmit` hook. Isolates H1's delta to the Haiku COMPILE, not "rule-text beats a pathname." |
| 6 | `strategies/h1.ts` | H1: `UserPromptSubmit` (pre-turn) Haiku compile → binding instruction sheet; `Stop` (post-turn) Haiku verify. Both via the direct Messages API (L4), `claude-haiku-4-5`, fresh token. A throttled/empty Haiku response marks the turn INVALID (≠ violation — F14). |
| 7 | `judge.ts` | `AdherenceJudge extends AgentAdapter` (role=JUDGE, **STRONG model — Claude Sonnet/Opus, not gpt-5-mini**; seam per `custom-judge-with-traces.test.ts:21-57`). Denominator = the scenario's **AUTHORED** applicable set (not judged). Scores `followed`/`transitiveChainFollowed` from **`tool_use`/`tool_result` evidence ONLY** — ignores assistant prose/`thinking` AND hook-injected turns (F4). Emits attribution ∈ {retrieval-miss, instruction-sheet-miss, agent-override}. Gated by `run-shape-floor`. |
| 8 | `fixtures/` | **5–8 ground-truth substrate fixtures** (0 CC sessions), each declaring `{applicable set, per-proc followed, ground-truth attribution}`: adherent; transitive-miss; claims-in-`thinking`-but-no-action; wrong-attribution (retrieval-miss vs agent-override); applicable-but-never-surfaced. Drives AC5's accuracy gate. |
| 9 | `instrument.ts` | Denominator accounting: EXCLUDE `is_error`/429/auth-fail/hook-fail turns (report an excluded-count), never score `followed=false` (F14). Detect the rate-limit adapter-throw that ABORTS the whole run (`scenario-agent-throw-aborts-run`) → CHECKPOINT per-session verdicts to disk + report "aborted, not measured." INTERLEAVE strategy/trial order. |
| 10 | `scenarios/` | `UserSimulatorAgent`-driven long sessions; distractor turns each plausibly match a DIFFERENT procedure's keywords; the target moment is phrased to NOT token-overlap its target procedure's frontmatter keywords (defeats a ≥2-token BM25 gate — F7). `description` is procedure-agnostic (it is interpolated VERBATIM into the user-sim system prompt — #705 leak class). |
| 11 | `calibration.ts` + `calibration.json` | Pre-registered discrimination calibration (F13): fixes the admissible band on a HELD-OUT scenario BEFORE scored trials; committed. |
| 12 | `adherence.test.ts` | vitest entry, `describe.skipIf(!RUN_ADHERENCE)`, SERIAL. Slice-0 substrate gate; slice-1 H1 vertical + fixtures; slice-2 head-to-head; growth loop. |
| 13 | `FINDINGS.md` | Answers the two questions with the CI-scoped result + discrimination verdict; embedded into the draft-PR body. |
| (fallback) | `cc-transcript.ts` | On-disk-tree parser, **pinned copy** from the `spike/779-from-transcript` branch (PR #789). FALLBACK-ONLY (used iff slice-0 shows the stdout path insufficient). If used: pin the copy + add a fixture test proving `linearize` picks the right tip on a transcript CONTAINING hook-injected nodes (F11). |

### Key anchors
- Adapter config: `javascript/src/agents/claude-code/claude-code-agent.adapter.ts:207-273`. Exports (reuse, don't reimplement): `parseStreamJson` + `ClaudeStreamMessage` (`.../claude-code/index.ts`) return STRUCTURED messages with `tool_use`/`tool_result` intact — the judge parses the tee'd stdout with these.
- Judge seam: `javascript/examples/vitest/tests/custom-judge-with-traces.test.ts:21-57`.
- Injection PATTERN: `skill-injection.ts:41-111` — but write to `$CLAUDE_CONFIG_DIR`, NOT cwd (L2).
- Run-shape floor shape: `~/.claude/scenario-tests/run-lib-shape.ts` (`assertRunShapeFloor`).
- H1 side-call: `services/claude-router` + `sol.2026-07-07-claude-oauth-custom-side-calls`.
- Substrate ground-truth: `~/.claude/scenario-tests/claude-repl-adapter.ts:608-618` + `sol.2026-06-12-claude-2.1.175-no-flat-jsonl` (why stdout, not flat JSONL).

## 5. Slice sequence (H1-first; smallest vertical slice before breadth)

**Slice 0 — foundations + the two MUST-PASS gates (do first; gate everything downstream).**
- Scaffolding: `sandbox.ts` (L1/L2/L3/L5), `generate-corpus.ts` (>200k tokens, chains, manifest), `tee-substrate.ts`.
- **GATE A — substrate integrity (F0, AC2):** one real fresh `claude -p` session → the tee'd substrate the judge reads contains ≥1 `tool_use` AND ≥1 `tool_result`. If not, stop and fix the substrate before anything else. (1 CC session.)
- **GATE B — discrimination pre-registration (F13, AC7):** fix the admissible band on a held-out scenario; commit `calibration.json`. (≤2 CC sessions, baseline arm.)

**Slice 1 — H1 vertical on ONE scenario (the loop the owner SEES). Exhibits all 3 DoD properties.**
1. Corpus past threshold (AC1) + `strategies/h1.ts` materialized.
2. ONE context-load scenario, load QUALITY not count (AC4).
3. `judge.ts` (strong model, action-only, authored denominator) behind `run-shape-floor`.
4. **Judge accuracy gate on the 5–8 fixtures (AC5) — 0 CC sessions.** Lands BEFORE any head-to-head number is trusted.
5. Growth loop (AC9): violate → subject-authored `Write` adds an `active` PROCEDURE.md → FRESH session adheres UNPROMPTED + held-out novel-form variant.

**Slice 2 — head-to-head (fair baseline vs H1). Fixed corpus (growth is separate).**
- `strategies/baseline.ts` (bodies-injecting) added.
- Scored matrix over 2 situations × 3 trials × 2 strategies = 12 sessions, order INTERLEAVED (F14), verdicts CHECKPOINTED.
- Report session-level rate + Wilson CI + attribution breakdown + excluded-count, side by side (AC6), gated by the discrimination result (AC7) and instrument integrity (AC8).

**Slice 3 — findings + draft PR (AC10).** `FINDINGS.md`; DRAFT PR (never merged), assignee + reviewer, embedded prove-it, ship-surface secret scan.

**Run-count budget (≤24 CC subject sessions):**

| Component | Sessions |
|---|---|
| Slice-0 GATE A substrate | 1 |
| Slice-0 GATE B calibration (held-out) | 2 |
| Slice-2 head-to-head (2 sit × 3 trials × 2 strat) | 12 |
| Growth loop (violation + fresh-same-form + held-out × 2 arms) | 4 |
| Slack / below-floor re-runs | ≤5 |
| **Total** | **≤24** |
| Judge fixture battery (AC5) | 0 |

H1 adds 2 Haiku Messages-API calls/turn from the SAME bucket; on 429, SERIALIZE (interleaved) rather than raise the cap. Effective statistical N ≈ sessions (~9–12), NOT per-procedure judgments (§AC6).

## 6. Alternatives — decisions + recommendations

| Decision | Options | Recommendation & why |
|---|---|---|
| **Judge substrate** | tee'd stream-json **STDOUT** vs on-disk flat JSONL vs flattened string | **Tee'd STDOUT (PRIMARY).** Flat JSONL may be an `ai-title` stub on 2.1.207 (F0, candidate-fatal); the flattened string discards structure. Stdout carries intact `tool_use`/`tool_result`; parsed by exported `parseStreamJson`. On-disk tree = fallback-only. |
| **Corpus source** | GENERATED synthetic vs vendored codex snapshot | **Synthetic, neutral vocab.** Public repo + `fm.langwatch-content-in-codex` bar codex content; synthetic is also BETTER — controlled A→B chains, controlled keyword-overlap, calibrated difficulty, honest token budget. |
| **Baseline arm** | fair BM25-injects-BODIES vs codex pointer-only router | **Bodies-injecting (F1).** Pointer-only + store-crippled conflates "Haiku compile" with "content beats a pathname" — the single most likely FALSE "H1 works." Pointer-only router → §DEFER (optional cheap reference). |
| **Judge model** | strong (Claude Sonnet/Opus) vs gpt-5-mini | **Strong (F3).** The judge is the whole ballgame; author applicability so the denominator is stable + cheap, judge only decides FOLLOWED from action evidence. |
| **"followed" evidence** | action (`tool_use`/`tool_result`) only vs incl. prose/`thinking` | **Action-only (F4).** H1 injects its own sheet + reasons in prose; counting text biases scoring toward H1. |
| **Stats** | iid per-procedure vs session-clustered | **Session-clustered + Wilson CI (F12).** Judgments cluster by session; claim only "no large effect detected," never "disproven." |
| **Harness language** | TS/vitest vs Python port | **TS/vitest.** Adapter is JS-only (#687). |
| **Known residual confound** | — | **H1 bundles compile + Stop-verify** — v0 can't attribute the effect to one; kept as owner-defined, flagged, ablation → §DEFER. |

## 7. Risks, DA-finding map, and residuals

| DA finding | Where addressed |
|---|---|
| **F0** substrate stub (candidate-fatal) | §3 substrate flip + **AC2** GATE A |
| **F5** no degenerate-run floor | `run-shape-floor.ts` + **AC5** |
| **F1** baseline confound (most likely false "H1 works") | `strategies/baseline.ts` bodies-injecting + **AC6** |
| **F3** weak judge | strong model + authored denominator, **AC5** |
| **F4** judge reads H1's own sheet | action-only scoring, **AC5/AC6** |
| **F2** corpus token math (50 files ≈76k < 200k) | synthetic, token-gated, **AC1** |
| **F13** no discrimination gate | pre-registered calibration, **AC7** |
| **F14** errored turns scored as violations + run-abort | `instrument.ts`, **AC8** |
| **F12** clustered stats overclaim | session-level Wilson CI, **AC6** |
| **F7** load = counts not quality | keyword-evasive distractors/target, **AC4** |
| **F8** growth: "later turn OR", unnamed author, H1-only variant | fresh-session + subject `Write` + both-arm held-out, **AC9** |
| **F9** process-global configDir cross-contamination | SERIAL vitest + env snapshot/assert, **AC3** |
| **F6** multi-JSONL race inverts AC6 | fresh workDir + stdout-primary, **AC3/AC9** |
| **F10** vacuous secret grep (symlink not traversed) | realpath-outside-repo + regular-file scan, **AC3**; ship-scan **AC10** |
| **F11** throwaway parser, wrong tip on hook nodes | fallback-only + pinned + tip fixture test |

**Top residuals I could NOT fully close within the minimal budget (surface to owner):**
1. **Compile-vs-Stop-verify confound.** H1 bundles both; a positive result can't say which half drives it. Ablation deferred.
2. **Low statistical power.** Effective N ≈ 9–12 sessions; only a LARGE H1 effect is detectable. A null is "no large effect detected," never "H1 disproven."
3. **Corpus-realism external validity.** Synthetic neutral-vocab procedures are cleaner and safer but are NOT the messy real corpus; "H1 works here" may not transfer to the owner's actual procedures.

---

## 8. AC draft

<!-- ACs ready for ac-reviewer -->

Each AC maps to a mandatory DoD property, a required deliverable, or a named validity gate. Evidence = captured stdout/paths from a real `RUN_ADHERENCE=1` run this turn (NOT CI-green, NOT a test plan).

**Secret-scan pattern (SECRET_RE) matches VALUE shapes, NOT identifier names** — the H1 hook script, `h1.ts`, and this plan legitimately contain the words `Bearer`/`accessToken`/`claudeAiOauth`, so a name-grep is self-defeating (it flags clean files). Use: `sk-ant-oat[A-Za-z0-9_-]{8,}` | `sk-lw-[A-Za-z0-9]{16,}` | `eyJ[A-Za-z0-9_-]{20,}\.` (JWT-shaped token) | `Bearer [A-Za-z0-9._-]{24,}` (a POPULATED header). `Bearer $(jq …)` and bare `.claudeAiOauth.accessToken` jq paths do NOT match — verified this plan doc scores 0 against SECRET_RE.

**AC1 — Corpus past the stuffing threshold, by REAL token count** *(DoD prop 1)*
The generated synthetic corpus is **> 200,000 tokens** measured by a real tokenizer (not chars÷N), contains **≥1 authored A→B transitive chain**, and uses neutral vocabulary. File count is reported but is NOT the gate. Edge: a 50-avg-procedure corpus (~76k tokens) FAILS this AC — the token budget, not the file count, is the bar.
- **Fails if:** tokenizer count ≤ 200,000; OR no A→B chain in the manifest; OR the banned-term list (codex/langwatch vocabulary) matches >0.
- **Evidence:** tokenizer total (>200000) + manifest showing ≥1 chain + `grep -f banned-terms corpus/` = 0, stdout.

**AC2 — Substrate integrity: the judged substrate carries real action records** *(validity gate; F0; MUST-PASS before slice 1)*
On claude 2.1.207, one real FRESH `claude -p` session's PRIMARY substrate (the tee'd stream-json stdout the judge reads) contains **≥1 `tool_use` AND ≥1 `tool_result`** event after `parseStreamJson`. The on-disk flat JSONL is checked informationally (stub vs full) but is NOT the judged substrate unless it also carries records.
- **Fails if:** the judged substrate has 0 `tool_use` OR 0 `tool_result`; OR the judge is wired to a substrate that is empty/stub.
- **Evidence:** `grep -c '"type":"tool_use"'` and `grep -c '"type":"tool_result"'` on the tee file (both ≥1) + a one-line note on whether the flat JSONL was full or an `ai-title` stub, stdout.

**AC3 — Harness drives an AUTHENTICATED, isolated, cred-safe, serial subject** *(minimal-loop + isolation ripple; F6/F9/F10-runtime; L1/L2/L5)*
`scenario.run` drives the subject with `CLAUDE_CONFIG_DIR = <sandbox>/.claude` (creds SYMLINKED, L1) and a CLEAN FRESH `workingDirectory` per session; the subject AUTHENTICATES and returns a real assistant turn (NOT `is_error` "Not logged in"); vitest runs SERIAL (`fileParallelism:false`, `maxConcurrency:1`) with `CLAUDE_CONFIG_DIR` snapshot/restored and the child's configDir asserted per run. Runtime cred-safety: the sandbox cred entry is a SYMLINK whose `realpath` is OUTSIDE the repo, no REGULAR file in the sandbox matches SECRET_RE, and `.credentials.json` + the sandbox dir are gitignored.
- **Fails if:** subject session is `is_error`/"Not logged in"; OR `configDir` resolves to real `~/.claude`; OR the cwd carries a stray `CLAUDE.md`/`.claude`; OR any REGULAR file in the sandbox matches SECRET_RE; OR the cred symlink's realpath is inside the repo; OR tests run concurrently.
- **Evidence:** session result (not `is_error`) + asserted `configDir` (≠ real) + `readlink -f <sandbox>/.claude/.credentials.json` outside the repo + `find <sandbox> -type f -exec grep -lE "$SECRET_RE" {} +` = 0 (regular files only — the symlinked cred is skipped; the hook's `Bearer $(jq …)` is not a VALUE) + `git check-ignore` on the cred path + sandbox dir + the vitest serial config, stdout.

**AC4 — Load QUALITY mid-session (not turn-count)** *(DoD prop 2; F7)*
≥1 scenario buries the target moment behind **≥N distractor turns each plausibly matching a DIFFERENT procedure's keywords**, AND the target moment is phrased so it does NOT token-overlap the target procedure's frontmatter keywords (a ≥2-token BM25 gate MISSES it). Distractor load is quantified (tokens and/or tool-calls). "Non-trivial" is not used.
- **Fails if:** distractors don't map to distinct other procedures; OR the target moment shares ≥2 frontmatter keywords with its target procedure (BM25 would trivially hit); OR load is unquantified.
- **Evidence:** the distractor→procedure keyword map + the target-moment vs target-frontmatter token-overlap count (<2) + distractor token/tool-call totals, stdout.

**AC5 — Run-shape floor + strong-model judge accuracy & attribution correctness** *(judge-is-ballgame / anti-theater; F5/F3/F4)*
The pre-judge `run-shape-floor` EXCLUDES any below-shape run (a monologue/stub/aborted run is never scored). The STRONG-model judge, run over the **5–8 ground-truth fixtures** (0 CC sessions), scoring FOLLOWED from `tool_use`/`tool_result` ONLY against AUTHORED applicability, must **equal** each fixture's declared ground truth on BOTH `followed` and `attribution`; ≥2 distinct attribution classes are proven (≥ retrieval-miss vs agent-override). Includes the transitive-miss fixture (A followed, invoked B skipped → `transitiveChainFollowed=false`) and the claims-in-`thinking`-but-no-action fixture (→ `followed=false`).
- **Fails if:** any fixture's `followed` OR `attribution` ≠ declared ground truth; OR fewer than 2 attribution classes proven; OR the floor passes a below-shape run; OR the judge scores `followed=true` on the thinking-only-no-action fixture.
- **Evidence:** per-fixture table {declared vs judged: applicable, followed, attribution} with 100% match + one below-floor input shown excluded, stdout.

**AC6 — H1 vs fair baseline: authored denominator, action-only, session-level rate + CI** *(owner's H1; F1/F4/F12)*
Both strategies run the SAME scored scenario set; the BASELINE injects matched procedure **BODIES** (asserted: injected context contains body text, not just paths). Per strategy, report the adherence rate over AUTHORED-applicable procedures, scored action-only, at **session level with a Wilson 95% CI** and an attribution breakdown, side by side. The FINDINGS claim is scoped to "no large effect detected" when CIs overlap — never "H1 disproven." H1 sessions evidence that both Haiku hooks fired (not a silent no-op).
- **Fails if:** baseline injects pointers-only/store-crippled; OR the denominator is judge-decided rather than authored; OR rates are reported without N and CI; OR the write-up says "H1 disproven"; OR an H1 session shows neither Haiku hook fired.
- **Evidence:** results table [strategy, N sessions, rate, Wilson CI, attribution counts, excluded-count] from the real run + a baseline-injection sample proving BODY text was injected + per-H1-session hook-fired log, stdout.

**AC7 — Discrimination gate (pre-registered)** *(validity gate; F13)*
The scenario set is admissible only if the BASELINE rate lands OFF both rails — within ~[20%, 80%] with **≥M followed AND ≥M violated judgments (M≥5)** — and this band was FIXED on a held-out scenario BEFORE the scored trials (committed `calibration.json`). A baseline-fidelity control confirms an OBVIOUS keyword-hit scenario → the router provably retrieves the right procedure body. If BOTH arms hit a rail, FINDINGS reports "no discrimination", never "H1 = baseline."
- **Fails if:** `calibration.json` is absent or written after scored trials; OR the baseline rails (<20% or >80%, or <5 either side) yet a comparative verdict is still claimed; OR the fidelity control's obvious hit is NOT retrieved.
- **Evidence:** committed `calibration.json` (pre-trial timestamp) + baseline rate in-band with the ≥5/≥5 counts + the fidelity-control retrieval shown, stdout.

**AC8 — Instrument integrity: errored turns excluded, run-abort survived** *(validity gate; F14)*
Errored/throttled/auth-failed/hook-failed turns are EXCLUDED from the rate denominator and reported as an excluded-count — never silently scored `followed=false`; a throttled/empty Haiku hook marks its turn INVALID. The rate-limit adapter-throw that ABORTS the whole run is detected → per-session verdicts are CHECKPOINTED to disk (survive the abort) and the run reports "aborted, not measured"; strategy/trial order is INTERLEAVED.
- **Fails if:** any `is_error`/429/hook-failure turn is counted in a denominator; OR an aborted run loses already-computed verdicts; OR order is all-one-strategy-first; OR a throttled-hook turn is scored as an H1 violation.
- **Evidence:** per-strategy `{total, excluded, judged}` counts (denominator == judged) + ONE forced-error run (unseed the cred or force a 429) showing the turn flagged/excluded not scored 0 + the on-disk verdict checkpoint + the interleaved order log, stdout.

**AC9 — Growth → unprompted later adherence (loop closes)** *(DoD prop 3; F8/#705)*
The subject VIOLATES a not-yet-adopted rule; then via the meta-procedure the SUBJECT ITSELF writes a new `active` `PROCEDURE.md` into the corpus (observed as the subject's own `Write` `tool_use` in the substrate — the real self-hardening loop); then a **FRESH session** (new adapter, NO `--resume`; the on-disk corpus is the SOLE carrier) adheres UNPROMPTED, AND a **held-out novel-form variant** (ZERO distinctive-keyword overlap with the trigger, same procedure provably applicable) adheres — run for BOTH strategies. The scenario `description` is procedure-agnostic (greps clean of every procedure name — no user-sim leak).
- **Fails if:** adherence needs a re-prompt (rule text present in the after-prompt); OR the new PROCEDURE.md was written by the harness rather than the subject's `Write`; OR the held-out variant shares distinctive keywords or is H1-only; OR any scenario `description` names a procedure; OR the fresh session used `--resume`.
- **Evidence:** violation substrate + the subject's `Write` `tool_use` adding an `active` PROCEDURE.md + corpus diff (+1) + fresh-session (no-`--resume`) adherence with `grep` of the after-prompt showing the rule text ABSENT + held-out-variant verdicts for both arms + `grep` of descriptions = 0 procedure names, stdout/paths.

**AC10 — Findings + DRAFT PR + ship-surface secret scan** *(required deliverable + security ship-gate; F10-ship)*
`FINDINGS.md` answers (i) "does violation→harden→re-run→unprompted-adherence close?" and (ii) the H1-vs-baseline result WITH its CI scope and the AC7 discrimination verdict. A DRAFT PR (never merged) has an assignee + a human reviewer requested and embeds a prove-it demo (real run stdout). The SHIP surface carries no secret: `git diff main...<branch>`, the rendered PR body, and any embedded stdout all return 0 matches for SECRET_RE (embedded stdout can echo a `Bearer` header → scrub it). The symlink target is NEVER resolved/tarred into FINDINGS/PR.
- **Fails if:** PR is non-draft/merged; OR no reviewer/assignee; OR a question is unanswered or the result isn't CI-scoped; OR the diff/PR-body/embedded-stdout matches SECRET_RE.
- **Evidence:** `gh pr view --json isDraft,reviewRequests,assignees` (`isDraft:true` + reviewer + assignee) + `git diff main...<branch> | grep -cE "$SECRET_RE"` = 0 + a grep of the rendered PR body + embedded stdout = 0, stdout.

---

## DEFER (explicit follow-ups — keep v0 minimal)
- **Pointer-only codex-router 3rd arm** (only if budget allows; else a separate spike).
- **Compile-vs-Stop-verify ablation** (split H1 into its two halves).
- **>8-fixture judge battery** + inter-rater/human-audit of the judge.
- **Full Wilson-CI/power rigor** beyond honest framing (n≈30/cell with proper clustering).
- **>1 real-run transitive-chain scenario** and multi-class breadth.

## Handoff
- ACs ready for ac-reviewer (see §8). Do NOT tick without proof-it-works evidence matching each declared shape.
- After ac-reviewer sharpens + owner confirms: mirror each AC (currently AC1–AC10) into TaskList — one `TaskCreate` per AC (done-gate requirement).
- MUST-PASS gates FIRST: **AC2 (substrate)** and **AC7 calibration** gate every downstream number; **AC5 (judge accuracy)** gates any head-to-head claim.
- Implementation → **advanced-coder/coder** for `judge.ts`, `instrument.ts`, `generate-corpus.ts`, strategies (judgment-bearing); **fast-coder** for the pinned `cc-transcript.ts` copy + tee-shim + boilerplate. Per `~/.claude/references/model-selection.md`.
- Security non-negotiables: **AC3** (runtime cred isolation) + **AC10** (ship-surface scan) are merge-blockers.
