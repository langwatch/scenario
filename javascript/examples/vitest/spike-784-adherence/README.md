# spike-784-adherence — procedure-adherence judge harness (v0 increment)

Builds and PROVES the core of the #784 procedure-adherence experiment **at zero
subscription cost**, before any live experiment run. The experiment in one line:
a Scenario drives a sandboxed Claude Code subject under context load; an
**AdherenceJudge** reads the subject's transcript and scores, per applicable
procedure, whether the subject FOLLOWED it (transitively) + an attribution for
any miss → an adherence RATE. **The judge is the whole ballgame** — this
increment builds and proves it.

See the plan: `plans/2026-07-11-784-procedure-adherence-v0.md` (§3 architecture,
§8 AC1/AC2/AC5).

## What this increment delivers

| File | Responsibility |
|---|---|
| `generate-corpus.ts` + `corpus/` | Deterministically generate ≥130 neutral-vocab `PROCEDURE.md` totalling **>200k real tokens** (gpt-tokenizer), with authored A→B transitive chains, a meta-procedure, and `corpus/manifest.json`. |
| `corpus-loader.ts` | Parse `corpus/` back into a `CorpusIndex` + manifest (used by AC1 and the later live run). |
| `types.ts` | The one shared contract: raw `ClaudeStreamMessage[]` substrate → `NormalizedTurn[]` (the view the floor + judge reason over). |
| `normalize.ts` | `normalizeTurns` (classifies `user` events into real **human** turns vs **tool**-result turns) + `extractActionLog` (the action-only evidence the judge scores from). |
| `run-shape-floor.ts` | `assertRunShapeFloor` / `passesRunShapeFloor` — a below-shape run (monologue/stub/aborted) is EXCLUDED, never judged. Shape mirrors `~/.claude/scenario-tests/run-lib-shape.ts`. |
| `judge-core.ts` | Strong-model scoring (framework-free). Model decides ONLY `followed` per procedure from `tool_use`/`tool_result` evidence; `applied`/`surfaced`/`transitiveChainFollowed`/`attribution` are deterministic. Providers: Claude Max OAuth (primary) + OpenAI (fallback). |
| `judge.ts` | `AdherenceJudge extends AgentAdapter` (`role = JUDGE`) — the `scenario.run` seam, delegating to `judge-core`. Reads the tee'd substrate. |
| `tee-substrate.ts` | Tee the child `claude -p` RAW `stream-json` stdout to `<workDir>/.transcript/<n>.stream.jsonl` (via a `claudeBin` shell shim — no core edits) + `readSubstrate` (reuses the exported `parseStreamJson`). |
| `fixtures/` | 6 hand-authored ground-truth transcript fixtures covering the judge's failure surface. |
| `prove-ac1.ts` / `prove-ac5.ts` / `gate-a.ts` | The three AC proofs. |
| `prove-fixes.ts` | Offline (0 CC sessions) proof for the two post-live-dry-run #784 fixes: the corpus floor is genuinely reachable (live judge) + H1 attribution correctness (deterministic wiring). See "#784 fixes" below. |

## How to run (from `javascript/examples/vitest/`)

```bash
# AC1 — corpus (0 subscription cost)
tsx spike-784-adherence/generate-corpus.ts        # regenerate corpus/ (committed)
tsx spike-784-adherence/prove-ac1.ts              # >200k tokens, >=1 chain, banned=0

# AC5 — judge accuracy over fixtures (THE ballgame; strong-model API calls, 0 CC sessions)
ADHERENCE_OFFLINE=1 tsx spike-784-adherence/prove-ac5.ts   # deterministic-logic check (no API)
ADHERENCE_JUDGE_MODEL=gpt-5.1 tsx spike-784-adherence/prove-ac5.ts   # LIVE strong judge

# #784 fixes — floor-saturation + H1 attribution (0 CC sessions; live gpt-5.1 judge calls for FIX 1)
ADHERENCE_JUDGE_MODEL=gpt-5.1 tsx spike-784-adherence/prove-fixes.ts

# GATE A — one real claude -p session, substrate integrity (F0/AC2)
tsx spike-784-adherence/gate-a.ts
```

## AC evidence captured this increment

- **AC1 — PASS.** 168 files, **257,605 real tokens** (`gpt-tokenizer/o200k_base`, gate >200,000; regenerated
  post-fix, see "#784 fixes" below — was 144 files / 242,404 tokens with 16-21-step procedures);
  manifest shows **4 authored A→B chains** (incl. a 3-hop `onboard-vendor → provision-account → grant-access`);
  banned-term grep (internal/proprietary vocabulary blocklist) = **0**; meta-procedure `author-procedure` present.
- **AC5 — PASS (live).** The strong judge equals declared ground truth on BOTH `followed` and `attribution`
  for **10/10** procedures across **6/6** fixtures; **3 distinct attribution classes**
  (`agent-override`, `retrieval-miss`, `instruction-sheet-miss`); the transitive-miss fixture scores chain=false;
  the thinking-only-no-action fixture scores followed=false; the floor EXCLUDES a below-shape input.
- **GATE A (F0/AC2) — PASS.** One fresh `claude -p` session (claude 2.1.207) through the tee produced a substrate
  with **tool_use=2 AND tool_result=2** (raw grep and parsed `readSubstrate` agree); auth via the SYMLINKED
  `.credentials.json`; clean cwd. On 2.1.207 the on-disk flat JSONL was FULL (not an `ai-title` stub), but the
  tee'd stdout remains the robust primary substrate.

## Judge model + auth (documented choice)

Primary per the plan is **Claude Sonnet via Claude Max OAuth** (`judge-core.ts` implements it;
token read fresh from `~/.claude/.credentials.json` with `Authorization: Bearer …` +
`anthropic-beta: oauth-2025-04-20`). On this shared box the Max bucket was **hard-throttled**
(429 through 60s backoffs) during the run. There is **no `ANTHROPIC_API_KEY`**. Per the brief's explicit
fallback ("whatever key the scenario examples already use … strongest reliably-accessible model"), the AC5
evidence was produced with **OpenAI `gpt-5.1`** (frontier-strength — NOT the plan's disallowed `gpt-5-mini`),
loaded at runtime from a gitignored scenario `.env` (never committed). Re-running with
`ADHERENCE_JUDGE_MODEL=claude-sonnet-4-5` reproduces AC5 on Sonnet once the bucket frees.

## Security

- Zero secrets committed (`SECRET_RE` scan = 0 over the spike dir).
- The sandbox `.credentials.json` is a SYMLINK (realpath outside the repo); the runtime `.sandbox/` is gitignored.
- The OpenAI key is read at runtime from an external `.env` (path overridable via `ADHERENCE_OPENAI_ENV`).

## Increment 2 — the LIVE loop (strategies + scenario + wiring; ONE live H1 session)

| File | Responsibility |
|---|---|
| `strategies/hooks-lib.mjs` | Self-contained hook runtime (node builtins): BM25 retrieval over the corpus + the direct OAuth Haiku Messages-API calls (compile / verify) + the `baseline`/`h1-compile`/`h1-verify` hook dispatch. Importable by the offline smoke; runnable as the hook. |
| `strategies/common.ts` | Builds the Claude Code `command`-hook entries (env baked in) written into `settings.json`. |
| `strategies/baseline.ts` | Fair-retrieval baseline: one `UserPromptSubmit` hook that BM25-retrieves and injects matched procedure **bodies** (F1). |
| `strategies/h1.ts` | H1: `UserPromptSubmit` Haiku **compile** (binding instruction sheet) + `Stop` Haiku **verify**, both via the direct OAuth Messages API — never `claude -p --model haiku` (L4). |
| `sandbox.ts` | `buildSandbox(strategy)`: isolated `.claude` (creds SYMLINKED, L1) + clean project cwd (L2) **outside the repo tree** + corpus via global config + strategy hooks (L3) + tee shim; env snapshot/restore + configDir assertion (L5). |
| `scenarios/context-load.ts` | ONE keyword-evasive, distractor-loaded scenario (AC4); authored applicable set = judge denominator; procedure-agnostic description (leak-guarded). |
| `instrument.ts` | Excludes errored/throttled/auth-failed turns from the denominator; H1 hook-fired summary; per-session checkpoint (survives an abort). |
| `run-live.ts` | The live harness: `scenario.run([ ClaudeCodeAgentAdapter(tee'd), userSimulatorAgent, AdherenceJudge ])`. `SMOKE=1` drives one turn direct. |
| `offline-smoke.ts` | Full-pipeline proof without the subject bucket (on-disk tee→floor→judge positive path + instrument + hook-lib). |
| `finalize-verdict.ts` | Scores an already-captured substrate with the strong judge (0 new CC sessions) when the in-run judge is throttled. |

### Increment-2 evidence

- **offline-smoke — PASS.** On-disk tee→floor→judge scores the positive path 2/2 with `transitiveChainFollowed=true`; the instrument flags an errored run `hardError`/excluded; BM25 lands the evasive target in top-K; a real Haiku compile returns 200 naming the target.
- **ONE live H1 session — RAN end-to-end** (pre-#784-fixes; kept as historical evidence, substrate at `.sandbox/h1-1783740882052/`). `scenario.run` drove a real `claude -p` subject through the 4-turn context-load scenario; the tee captured 144 substrate turns / 17 tool_use + 17 tool_result; **both H1 Haiku hooks fired on every turn — 8/8 Messages-API 200s** (`bothHooksFired200=true`); the run-shape floor passed; the strong judge scored **adherence 0/2** (`followed=false` for `handle-refund` + `reconcile-invoice`), both misattributed `retrieval-miss`. Root-caused to TWO bugs, both now fixed (0 new CC sessions used to fix or prove them — see below): the raw corpus's 16-21-near-duplicate-step procedures made `followed=true` unreachable by construction, AND the subject's Edit/Write calls into the seeded project state were denied by the sandbox's permission mode (NOT a content/`old_string` mismatch — the `old_string` matched the seeded file byte-for-byte; see `sandbox.ts`'s `permissions.allow`).

## #784 fixes (post live-dry-run; offline-proved, 0 new CC sessions)

The live H1 dry run above surfaced two bugs; both are fixed and proved offline against canned substrate fixtures — see `prove-fixes.ts` (`tsx prove-fixes.ts`, live `gpt-5.1` judge calls for the model-judgment half, oracle-isolated for the deterministic-wiring half):

- **Floor-saturation (`generate-corpus.ts`).** Procedures now carry **~3-6 DISTINCT, bare-single-line steps** (was 16-21 steps cycling the same 4 stems, each with 2 generic elaboration bullets). The bullets turned out to be load-bearing to strip, not just the step count: a live `gpt-5.1` judge run against a step-count-only fix still scored a fully-adherent transcript `followed=false`, reading the (randomly-paired, often off-topic) elaboration bullets as additional required checks — removing them (matching `fixtures/index.ts`'s bare-step style) fixed it. Corpus grew from 144→**168 files** (24 new sensible verb/object pairs added, preferred over leaning almost entirely on filler padding) to stay >200k tokens with the shorter procedure bodies. `prove-fixes.ts` FIX 1 shows, with a **live** judge: a fully-adherent transcript on the real regenerated corpus scores `followed=true` for both `handle-refund` and `reconcile-invoice` (chain=true), and two distinct partial transcripts (one whole procedure skipped; one of the now-4 steps skipped) both correctly score `followed=false` — the floor is reachable AND still discriminates.
- **Sandbox permissions (`sandbox.ts`).** `settings.json` now grants `permissions.allow: ["Edit", "Write"]` (still DEFAULT permission mode overall, never `bypassPermissions`/`--dangerously-skip-permissions`) so a diligent subject's file mutations against the seeded project state aren't silently denied. This is a correction to the brief's working hypothesis, not the hypothesis itself: the live transcript showed the Edit's `old_string` matching the seeded `charge-8842.json` byte-for-byte, but Claude Code responding "Claude requested permissions to write to \<path\>, but you haven't granted it yet" — a permission-grant gap, not a content/seed-shape mismatch. (This part is NOT re-provable offline under the "0 CC sessions" constraint — it needs a live `claude -p` run to confirm; the settings.json shape was validated against the installed Claude Code settings schema instead.)
- **H1 attribution (`judge-core.ts` / `strategies/hooks-lib.mjs` / `instrument.ts` / `judge.ts`).** H1's compiled instruction sheet is delivered via the `UserPromptSubmit` hook's STDOUT, which `claude -p` folds into the subject's INPUT context — it is NEVER re-emitted into the tee'd `stream-json` STDOUT substrate (verified empirically: 0 occurrences of the real captured sheet's text in any `<n>.stream.jsonl`). So `computeSurfaced` could never see it, and a sheet-bound-but-skipped procedure was wrongly attributed `retrieval-miss` — exactly what happened to both `handle-refund` and `reconcile-invoice` in the live run above, even though the sheet named both (see `.sandbox/h1-1783740882052/.claude/adherence/last-sheet.txt`). `hooks-lib.mjs` now logs `compiledIds` (ids the compiled sheet TEXT actually names) per h1-compile event; `instrument.collectCompiledSheetIds` unions them across a run; `judge.ts`/`finalize-verdict.ts` feed them into `ScoreInput.compiledSheetIds`, which `computeSurfaced` now also checks (surfacing-only — `followed` stays action-only). `prove-fixes.ts` FIX 2 round-trips through the real hook-log write/read/aggregate functions and shows BEFORE (`compiledSheetIds` unfed — the exact pre-fix wiring) both procedures wrongly `retrieval-miss`, AFTER both correctly `agent-override` (the sheet DID bind them; the subject still skipped them), and a third procedure never retrieved/compiled anywhere staying `retrieval-miss` in both — the fix is additive/targeted, not a blanket "always surfaced". AC5's fixture suite (which already exercises the OTHER `instruction-sheet-miss` pathway via `f6`, unrelated to this fix) still matches ground truth 10/10 after this change.

## Scope / not-yet-built (increment 3)

The scored 12-session head-to-head matrix, the pre-registered discrimination calibration, and the growth loop
are OUT of scope here. One hardening item remains flagged for increment 3: run the subject under a
container/bwrap for true kernel-level isolation (the sandbox is now outside the repo, but absolute paths
elsewhere on the box are still reachable). The raw-corpus every-step gate is FIXED (above); a live re-run to
confirm the sandbox permissions fix end-to-end (0/2 → some nonzero adherence) is the natural next live session,
but is deliberately NOT done here (0 new CC sessions, offline validation only, per brief).
