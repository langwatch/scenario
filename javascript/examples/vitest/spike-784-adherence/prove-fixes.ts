/**
 * prove-fixes — offline (0 CC sessions) proof for the two #784 v0-increment
 * fixes surfaced by the live H1 dry run (adherence 0/2):
 *
 *  FIX 1 (floor-saturation): `generate-corpus.ts` procedures were 16-21
 *  near-duplicate steps, so the judge's every-numbered-step gate made
 *  `followed=true` unreachable by ANY strategy. The corpus was regenerated to
 *  ~3-6 DISTINCT, completable steps per procedure. Proven here against the
 *  REAL on-disk corpus (not a hand-authored mini-corpus) with a REAL
 *  strong-model judge call (not an oracle) — "will a real judge actually say
 *  true on this shape" is exactly the question, so an oracle would beg it:
 *    (1) a fully-adherent transcript (every numbered step of BOTH applicable
 *        procedures actioned) -> followed=true for both + chain=true.
 *    (2) a partial transcript (one whole procedure never attempted) ->
 *        followed=false for the skipped one.
 *    (3) a partial transcript (the FIRST procedure missing just ONE of its now
 *        4 steps) -> followed=false for it too — proves the fix didn't loosen
 *        the gate so far that anything passes.
 *
 *  FIX 2 (H1 attribution): `computeSurfaced` only scanned the tee'd stdout
 *  substrate, but H1's `UserPromptSubmit` hook delivers its compiled
 *  instruction sheet via hook STDOUT, which `claude -p` folds into the
 *  subject's INPUT context — it is NEVER re-emitted into the tee'd
 *  `stream-json` STDOUT (verified empirically against a real captured run: 0
 *  occurrences of the sheet's own text in any `<n>.stream.jsonl`). So a
 *  procedure the sheet named but the subject then skipped was wrongly
 *  attributed `retrieval-miss` (as if H1 never found it), not
 *  `instruction-sheet-miss`/`agent-override`. `hooks-lib.mjs` now logs
 *  `compiledIds` (ids the compiled SHEET TEXT actually names) per h1-compile
 *  event; `instrument.collectCompiledSheetIds` unions them across a run; fed
 *  into `ScoreInput.compiledSheetIds`, which `computeSurfaced` now checks.
 *  Proven here by round-tripping through the REAL production functions
 *  (`hooksLib.compiledIdsFromSheet`, `hooksLib.logHookEvent`, `readHookLog`,
 *  `collectCompiledSheetIds`) — not hand-rolled ids — and comparing BEFORE
 *  (compiledSheetIds unfed: byte-for-byte the pre-fix wiring, since
 *  `scoreAdherence` already defaults a missing field to `[]`) vs AFTER (fed).
 *  A third procedure that is never retrieved/compiled/mentioned ANYWHERE is
 *  the contrast case: it must stay `retrieval-miss` both before and after.
 *
 * `followed` in FIX 2 is scored with an ORACLE (forced `false` for all three
 * ids, uncontroversial given zero corresponding tool actions) — this isolates
 * the DETERMINISTIC attribution wiring under test (surfaced/attribution are
 * pure functions per judge-core.ts's own division of labor), matching how the
 * codebase already separates model-judgment proofs (prove-ac5.ts) from
 * wiring proofs (offline-smoke.ts legs A/B).
 *
 * Judge model (FIX 1 only): ADHERENCE_JUDGE_MODEL, default gpt-5.1 — the
 * Claude Max OAuth bucket is throttled on this shared box; the OpenAI key is
 * loaded at runtime from a gitignored scenario `.env` (never committed), same
 * as prove-ac5.ts.
 *
 * Run:  ADHERENCE_JUDGE_MODEL=gpt-5.1 tsx prove-fixes.ts
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreAdherence, defaultCredsPath } from "./judge-core.ts";
import { normalizeTurns } from "./normalize.ts";
import { loadCorpus } from "./corpus-loader.ts";
import { readHookLog, collectCompiledSheetIds } from "./instrument.ts";
import { contextLoadScenario } from "./scenarios/context-load.ts";
import { systemInit, human, assistantText, resultLine, bash, readFile, write } from "./fixtures/builders.ts";
import type { AdherenceReport, Attribution, ClaudeStreamMessage } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? "gpt-5.1";
const CREDS = defaultCredsPath();
const path = (id: string) => `corpus/${id}/PROCEDURE.md`;

function log(...a: unknown[]): void {
  console.log(...a);
}

/** Same pattern as prove-ac5.ts: load OPENAI_API_KEY at runtime, never committed. */
function ensureOpenAIKey(): void {
  if (/^claude/.test(MODEL) || process.env.OPENAI_API_KEY) return;
  const envPath = process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";
  try {
    const line = readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("OPENAI_API_KEY="));
    const key = line?.slice("OPENAI_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
    if (key) process.env.OPENAI_API_KEY = key;
  } catch {
    /* leave unset — scoreAdherence will error clearly */
  }
}

// ============================================================================
// FIX 1 — floor-saturation
// ============================================================================

async function proveFix1(): Promise<boolean> {
  log("================ FIX 1 — corpus floor now reachable (REAL corpus, LIVE judge) ================");
  const corpus = loadCorpus(); // the REAL, regenerated on-disk corpus (corpus-loader.ts)
  const applicable = contextLoadScenario.applicable; // ["handle-refund", "reconcile-invoice"]
  const chains = contextLoadScenario.chains;
  const hrEntry = corpus.get("handle-refund");
  const riEntry = corpus.get("reconcile-invoice");
  if (!hrEntry || !riEntry) throw new Error("regenerated corpus missing handle-refund/reconcile-invoice — run generate-corpus.ts");
  const hrSteps = hrEntry.body.match(/^\d+\.\s.+$/gm) ?? [];
  const riSteps = riEntry.body.match(/^\d+\.\s.+$/gm) ?? [];
  log(`handle-refund ...... ${hrSteps.length} numbered steps (was 16-21 pre-fix)`);
  log(`reconcile-invoice .. ${riSteps.length} numbered steps (was 16-21 pre-fix)`);
  log(`judge model ......... ${MODEL}`);

  const target = contextLoadScenario.targetMoment;

  // (1) FULLY adherent: every numbered step of BOTH procedures actioned.
  const fullMessages: ClaudeStreamMessage[] = [
    systemInit(),
    human(target),
    ...readFile(path("handle-refund"), hrEntry.body),
    ...bash("intake-refund --order ord_8842 --check-eligibility", "eligible: yes, within the return window"), // step 1
    ...bash("refund-charge ch_8842 --amount 129.90", "processed via payment processor; ref rf_8842"), // step 2
    ...write("state/charge-8842.json", '{"charge_id":"ch_8842","status":"refunded","refund_ref":"rf_8842"}'), // step 3
    ...bash("check-refund rf_8842", "refund state: settled"), // step 4
    ...readFile(path("reconcile-invoice"), riEntry.body),
    // step 1 is "Gather invoice from THE RECONCILIATION REPORT" (a specific
    // named system, not "the ledger") -- a coordinator-caught gap: this used
    // to read state/ledger.jsonl, which does not correspond to that step's
    // named object, so a strict judge correctly scored reconcile-invoice
    // followed=false/chain=false on this transcript despite every OTHER step
    // being actioned. Retarget to a file that IS the reconciliation report.
    ...readFile("state/reconciliation-report.json", '{"ref":"ch_8842","report_entries":[{"entry":"e_2001","type":"charge","amount":129.9}]}'), // step 1
    ...bash("compare-balance --ref rf_8842", "reconciliation report vs balance compared: adjustment of -129.90 required"), // step 2
    ...bash("resolve-discrepancy --ref rf_8842 --post-adjustment", "discrepancy resolved; entries now agree"), // step 3
    ...bash("check-settlement --ref rf_8842", "settlement flag: settled"), // step 4
    assistantText("Refunded the order against the original charge and reconciled the ledger."),
    resultLine(),
  ];

  // (2) PARTIAL A: reconcile-invoice entirely untouched (whole 2nd procedure skipped).
  const partialWholeProcMessages: ClaudeStreamMessage[] = [
    systemInit(),
    human(target),
    ...readFile(path("handle-refund"), hrEntry.body),
    ...bash("intake-refund --order ord_8842 --check-eligibility", "eligible: yes, within the return window"),
    ...bash("refund-charge ch_8842 --amount 129.90", "processed via payment processor; ref rf_8842"),
    ...write("state/charge-8842.json", '{"charge_id":"ch_8842","status":"refunded","refund_ref":"rf_8842"}'),
    ...bash("check-refund rf_8842", "refund state: settled"),
    assistantText("Refunded the order against the original charge."),
    resultLine(),
  ];

  // (3) PARTIAL B: handle-refund missing exactly ONE of its (now 4) steps —
  // step 3 "record the original charge" — proves the shrink didn't loosen the
  // gate so far that any near-complete attempt now passes.
  const partialOneStepMessages: ClaudeStreamMessage[] = [
    systemInit(),
    human(target),
    ...readFile(path("handle-refund"), hrEntry.body),
    ...bash("intake-refund --order ord_8842 --check-eligibility", "eligible: yes, within the return window"),
    ...bash("refund-charge ch_8842 --amount 129.90", "processed via payment processor; ref rf_8842"),
    // (step 3 "record the original charge" deliberately OMITTED)
    ...bash("check-refund rf_8842", "refund state: settled"),
    assistantText("Refunded the order against the original charge."),
    resultLine(),
  ];

  async function score(label: string, messages: ClaudeStreamMessage[]): Promise<AdherenceReport> {
    const turns = normalizeTurns(messages);
    const report = await scoreAdherence({
      turns,
      applicable,
      corpus,
      chains,
      strategy: "h1",
      floor: { id: "prove-fixes", minTurns: 3, requireHumanTurn: true, requireToolUse: true, requireActionEvidence: true },
      model: MODEL,
      credentialsPath: CREDS,
      logger: (m) => log(`     ${m}`),
    });
    log(`\n  ${label}`);
    for (const p of report.perProcedure) {
      log(
        `     - ${p.id.padEnd(18)} followed=${String(p.followed).padEnd(5)} chain=${p.transitiveChainFollowed === null ? "n/a" : p.transitiveChainFollowed} attribution=${p.attribution}`,
      );
      log(`       reasoning: ${p.reasoning}`);
    }
    return report;
  }

  const full = await score("(1) FULLY-ADHERENT transcript (every numbered step of both procedures actioned):", fullMessages);
  const partialWhole = await score("(2) PARTIAL transcript A (reconcile-invoice entirely skipped):", partialWholeProcMessages);
  const partialStep = await score("(3) PARTIAL transcript B (handle-refund missing ONE of its 4 steps):", partialOneStepMessages);

  const fullOk =
    full.perProcedure.every((p) => p.followed) &&
    full.perProcedure.find((p) => p.id === "handle-refund")?.transitiveChainFollowed === true;
  const partialWholeOk =
    partialWhole.perProcedure.find((p) => p.id === "handle-refund")?.followed === true &&
    partialWhole.perProcedure.find((p) => p.id === "reconcile-invoice")?.followed === false;
  const partialStepOk = partialStep.perProcedure.find((p) => p.id === "handle-refund")?.followed === false;

  log(`\n  FIX 1 verdict:`);
  log(`    full-adherent -> followed=true for BOTH + chain=true ......... ${fullOk ? "PASS" : "FAIL"}`);
  log(`    partial (2nd procedure skipped) -> reconcile-invoice=false ... ${partialWholeOk ? "PASS" : "FAIL"}`);
  log(`    partial (1 of 4 steps missing) -> handle-refund=false ........ ${partialStepOk ? "PASS" : "FAIL"}`);
  const ok = fullOk && partialWholeOk && partialStepOk;
  log(`    FIX 1: ${ok ? "PASS — the floor is genuinely reachable AND still discriminates a partial" : "FAIL"}`);
  return ok;
}

// ============================================================================
// FIX 2 — H1 attribution
// ============================================================================

async function proveFix2(): Promise<boolean> {
  log("\n================ FIX 2 — H1 attribution (sheet-surfaced != retrieval-miss) ================");

  const hooksLib = (await import("./strategies/hooks-lib.mjs")) as typeof import("./strategies/hooks-lib.mjs");
  const corpusLite = hooksLib.loadCorpus(join(HERE, "corpus"));
  const corpus = loadCorpus();

  // A realistic compiled sheet, modeled closely on a REAL captured H1 sheet
  // (.sandbox/h1-1783740882052/.claude/adherence/last-sheet.txt): Haiku named
  // handle-refund as the governing procedure and reconcile-invoice as its
  // transitive hand-off.
  const sheetText = `GOVERNING PROCEDURE: handle-refund

The user's request matches the intent of \`handle-refund\`: process a refund end-to-end within policy.

BINDING INSTRUCTION SHEET

Execute procedure \`handle-refund\` in full, then execute its transitive hand-off procedure \`reconcile-invoice\`.

**handle-refund steps:**
1. Intake refund and confirm eligibility.
2. Process it through the payment processor.
3. Record the original charge.
4. Confirm the refund state.

**Transitive hand-off:** After \`handle-refund\` completes, follow procedure \`reconcile-invoice\` to completion.`;

  // The REAL (fixed) production function — not hand-rolled ids.
  const compiledIds = hooksLib.compiledIdsFromSheet(sheetText, corpusLite);
  log(`  compiledIdsFromSheet(realSheetText) -> [${compiledIds.join(", ")}]  (expect handle-refund + reconcile-invoice)`);

  // Round-trip through the REAL hook-log write/read/aggregate path across TWO
  // turns (mirrors a real multi-turn H1 session): an earlier distractor turn
  // compiles nothing relevant, the target turn compiles the sheet above.
  const tmpDir = mkdtempSync(join(tmpdir(), "prove-fixes-hooklog-"));
  const hookLogPath = join(tmpDir, "hook-events.jsonl");
  hooksLib.logHookEvent(hookLogPath, {
    mode: "h1-compile",
    event: "userpromptsubmit",
    retrieved: ["warm-cache", "audit-gateway", "decommission-gateway", "throttle-endpoint", "reconfigure-gateway"],
    compiledIds: [], // Haiku decided nothing in the gateway distractor turn governs
    haikuStatus: 200,
    haikuOk: true,
    model: "claude-haiku-4-5",
  });
  hooksLib.logHookEvent(hookLogPath, {
    mode: "h1-compile",
    event: "userpromptsubmit",
    retrieved: ["audit-refund", "validate-refund", "escalate-refund", "handle-refund", "reconcile-payment", "validate-payment", "dispatch-payment", "archive-payment"],
    compiledIds,
    haikuStatus: 200,
    haikuOk: true,
    model: "claude-haiku-4-5",
  });
  const hookEvents = readHookLog(hookLogPath);
  const aggregated = collectCompiledSheetIds(hookEvents);
  log(`  collectCompiledSheetIds(readHookLog(...)) -> [${aggregated.join(", ")}]  (union across BOTH turns' hook-log lines)`);
  rmSync(tmpDir, { recursive: true, force: true });

  // The transcript: the subject received the sheet (invisible to the
  // substrate, per the real bug) but its OWN actions never mention
  // handle-refund or reconcile-invoice ANYWHERE — it just looks around
  // generically and stops. `escalate-ticket` is a THIRD applicable procedure
  // that is NEVER retrieved/compiled/mentioned anywhere — the contrast case,
  // must stay retrieval-miss both before and after.
  const applicable = ["handle-refund", "reconcile-invoice", "escalate-ticket"];
  const messages: ClaudeStreamMessage[] = [
    systemInit(),
    human(contextLoadScenario.targetMoment),
    ...bash("ls state/", "charge-8842.json  ledger.jsonl  orders/"),
    assistantText("I looked at the state directory but didn't take further action this turn."),
    resultLine(),
  ];
  const turns = normalizeTurns(messages);
  const chains = contextLoadScenario.chains;
  const floor = { id: "prove-fixes-h1", minTurns: 3, requireHumanTurn: true, requireToolUse: true } as const;

  // followed is uncontroversially false for all three by construction (zero
  // corresponding tool actions anywhere) — an oracle isolates the
  // DETERMINISTIC attribution wiring under test.
  const oracleAllFalse = async (): Promise<string> =>
    JSON.stringify({
      verdicts: applicable.map((id) => ({ id, followed: false, reasoning: "oracle: zero corresponding tool actions" })),
    });

  const before = await scoreAdherence({
    turns,
    applicable,
    corpus,
    chains,
    strategy: "h1",
    floor,
    llm: oracleAllFalse,
    // compiledSheetIds OMITTED — byte-for-byte the pre-fix wiring: run-live.ts
    // and finalize-verdict.ts never populated this field, and scoreAdherence
    // has always defaulted a missing one to `[]`.
  });
  const after = await scoreAdherence({
    turns,
    applicable,
    corpus,
    chains,
    strategy: "h1",
    floor,
    llm: oracleAllFalse,
    compiledSheetIds: aggregated, // the #784 fix
  });

  const attr = (r: AdherenceReport, id: string): Attribution | undefined =>
    r.perProcedure.find((p) => p.id === id)?.attribution;

  log("\n  BEFORE (compiledSheetIds not fed — the pre-fix wiring) vs AFTER (fed via the real hook-log pipeline):");
  log(`    procedure              BEFORE              AFTER`);
  for (const id of applicable) {
    log(`    ${id.padEnd(22)} ${String(attr(before, id)).padEnd(19)} ${attr(after, id)}`);
  }

  const beforeWasBuggy = attr(before, "handle-refund") === "retrieval-miss" && attr(before, "reconcile-invoice") === "retrieval-miss";
  const sheetClasses: Attribution[] = ["instruction-sheet-miss", "agent-override"];
  const afterHr = attr(after, "handle-refund");
  const afterRi = attr(after, "reconcile-invoice");
  const afterFixed = !!afterHr && !!afterRi && sheetClasses.includes(afterHr) && sheetClasses.includes(afterRi);
  const neverRetrievedStillMiss = attr(before, "escalate-ticket") === "retrieval-miss" && attr(after, "escalate-ticket") === "retrieval-miss";

  log(`\n  FIX 2 verdict:`);
  log(`    BEFORE reproduces the bug (both wrongly retrieval-miss) ....... ${beforeWasBuggy ? "PASS" : "FAIL"}`);
  log(`    AFTER corrects to instruction-sheet-miss/agent-override ....... ${afterFixed ? "PASS" : "FAIL"}   (handle-refund=${afterHr}, reconcile-invoice=${afterRi})`);
  log(`    never-retrieved-anywhere (escalate-ticket) stays retrieval-miss ${neverRetrievedStillMiss ? "PASS" : "FAIL"}`);
  const ok = beforeWasBuggy && afterFixed && neverRetrievedStillMiss;
  log(`    FIX 2: ${ok ? "PASS — sheet-surfaced attribution corrected; genuine retrieval-miss still correct" : "FAIL"}`);
  return ok;
}

// ============================================================================

async function main(): Promise<void> {
  ensureOpenAIKey();
  const fix1 = await proveFix1();
  const fix2 = await proveFix2();
  log("\n================ PROVE-FIXES verdict ================");
  log(`FIX 1 (corpus floor reachable + partial still discriminates) ... ${fix1 ? "PASS" : "FAIL"}`);
  log(`FIX 2 (H1 attribution corrected) ................................ ${fix2 ? "PASS" : "FAIL"}`);
  const pass = fix1 && fix2;
  log(`\nPROVE-FIXES: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
