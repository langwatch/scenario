/**
 * offline-smoke — prove the FULL increment-2 pipeline works end-to-end WITHOUT
 * drawing the subject's subscription bucket, for when the live path is throttled.
 *
 * Three legs:
 *  A. On-disk substrate path: author a realistic H1 handle-refund session as RAW
 *     stream-json, write it to a transcript dir exactly as the tee shim would,
 *     read it back with the REAL `readSubstrate`, gate it with the run-shape
 *     floor, and score it with the AdherenceJudge — first against the REAL
 *     corpus body with an oracle forced `false` (a negative-path wiring check
 *     only — the corpus was regenerated to ~3-6 completable steps per procedure
 *     so followed=true is genuinely reachable there with a real judge; see
 *     `prove-fixes.ts`), then against a tractable mini-corpus (shows the
 *     POSITIVE path -> followed=true + transitive chain). Uses a deterministic
 *     ORACLE for `followed` so leg A is zero-cost and isolates the wiring
 *     (floor / on-disk read / attribution / chain / instrument), which the live
 *     run, AC5, and `prove-fixes.ts` already prove for the model.
 *  B. Instrument integrity: an errored substrate ("Not logged in") is classified
 *     hardError/excluded — never scored followed=false (AC8 / F14).
 *  C. Hook-lib unit exercise: BM25 retrieval lands the evasive target in top-K and
 *     each distractor maps to a DISTINCT family; a real Haiku compile is probed
 *     (best-effort — reported, not required) to show the H1 hook's compile works.
 *
 * Run:  tsx offline-smoke.ts
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreAdherence } from "./judge-core.ts";
import { readSubstrate } from "./tee-substrate.ts";
import { extractActionLog } from "./normalize.ts";
import { passesRunShapeFloor } from "./run-shape-floor.ts";
import { classifyRun } from "./instrument.ts";
import { loadCorpus } from "./corpus-loader.ts";
import {
  systemInit,
  toolUse,
  toolResult,
  assistantText,
  resultLine,
  proc,
  miniCorpus,
} from "./fixtures/builders.ts";
import type { ClaudeStreamMessage, Chain } from "./types.ts";
import { contextLoadScenario } from "./scenarios/context-load.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SMOKE_DIR = join(HERE, ".sandbox", "offline-smoke");

function log(...a: unknown[]): void {
  console.log(...a);
}

/** Write a canned session to a transcript dir exactly as the tee shim would. */
function writeCannedSubstrate(workDir: string, prompt: string, events: ClaudeStreamMessage[]): void {
  const dir = join(workDir, ".transcript");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "1.prompt.txt"), prompt, "utf8");
  writeFileSync(join(dir, "1.stream.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/** A realistic H1 subject session that ENACTS refund + reconcile as tool actions. */
function refundSessionEvents(): ClaudeStreamMessage[] {
  const t1 = toolUse("Read", { file_path: "state/charge-8842.json" });
  const t2 = toolUse("Read", { file_path: "state/orders/ord_8842.json" });
  const t3 = toolUse("Bash", { command: "refund-charge ch_8842 --amount 129.90 --reason returned_item" });
  const t4 = toolUse("Write", { file_path: "state/refunds/rf_8842.json", content: '{"refund_id":"rf_8842","charge":"ch_8842","amount":129.9,"reason":"returned_item","status":"settled"}' });
  const t5 = toolUse("Bash", { command: "check-refund rf_8842" });
  const t6 = toolUse("Read", { file_path: "state/ledger.jsonl" });
  const t7 = toolUse("Write", { file_path: "state/ledger.jsonl", content: '{"entry":"e_2003","ref":"rf_8842","type":"refund","amount":-129.9,"balance":42.0}' });
  const t8 = toolUse("Bash", { command: "reconcile-ledger --check balance" });
  return [
    systemInit(),
    t1.msg,
    toolResult('{"charge_id":"ch_8842","amount":129.9,"status":"captured"}', { toolUseId: t1.id }),
    t2.msg,
    toolResult('{"order_id":"ord_8842","status":"returned"}', { toolUseId: t2.id }),
    t3.msg,
    toolResult("refund issued: rf_8842 amount 129.90", { toolUseId: t3.id }),
    t4.msg,
    toolResult("written", { toolUseId: t4.id }),
    t5.msg,
    toolResult("refund rf_8842 status: settled", { toolUseId: t5.id }),
    t6.msg,
    toolResult("e_2001 charge 129.90; e_2002 charge 42.00", { toolUseId: t6.id }),
    t7.msg,
    toolResult("written", { toolUseId: t7.id }),
    t8.msg,
    toolResult("ledger balances: line items and balance agree", { toolUseId: t8.id }),
    assistantText("Refunded the returned order against the original charge, recorded the reason, confirmed it settled, and reconciled the ledger so the books agree."),
    resultLine(),
  ];
}

/** Oracle llm: returns the given followed map, isolating the deterministic wiring. */
function oracle(followed: Record<string, boolean>): (s: string, u: string, m: string) => Promise<string> {
  return async () =>
    JSON.stringify({ verdicts: Object.entries(followed).map(([id, f]) => ({ id, followed: f, reasoning: "oracle" })) });
}

async function main(): Promise<void> {
  log("================ OFFLINE SMOKE — full pipeline without the subject bucket ================\n");

  // ---- Leg A: on-disk tee path -> floor -> judge ----
  const workDir = join(SMOKE_DIR, "run");
  const events = refundSessionEvents();
  writeCannedSubstrate(workDir, contextLoadScenario.targetMoment, events);
  const turns = readSubstrate(workDir);
  const actions = extractActionLog(turns);
  const floorOk = passesRunShapeFloor(turns, {
    id: "offline",
    minTurns: 5,
    requireHumanTurn: true,
    requireToolUse: true,
    requireActionEvidence: true,
  });
  log("LEG A — on-disk substrate -> readSubstrate -> floor -> judge");
  log(`  readSubstrate: ${turns.length} turns (human=${turns.filter((t) => t.role === "human").length}, tool_use=${actions.filter((a) => a.kind === "tool_use").length}, tool_result=${actions.filter((a) => a.kind === "tool_result").length})`);
  log(`  run-shape floor: ok=${floorOk.ok} ${floorOk.reason ?? ""}`);

  const chains: Chain[] = contextLoadScenario.chains;
  const applicable = contextLoadScenario.applicable;

  // A1: negative-path wiring check against the REAL corpus with an oracle
  // forced to `false` — proves a "nothing followed" verdict wires through
  // cleanly regardless of corpus shape. This is NOT a claim that followed=true
  // is unreachable on the real corpus: the corpus was regenerated to ~3-6
  // distinct, completable steps per procedure (was 16-21 near-duplicate steps,
  // the #784 H1 dry run's 0/2 floor-saturation bug) specifically so a REAL
  // strong-model judge CAN reach followed=true on a fully-adherent transcript —
  // see `prove-fixes.ts` (live gpt-5.1 judge calls) for that positive proof.
  const realCorpus = loadCorpus();
  const a1 = await scoreAdherence({
    turns,
    applicable,
    corpus: realCorpus,
    chains,
    strategy: "h1",
    floor: false,
    llm: oracle({ "handle-refund": false, "reconcile-invoice": false }),
  });
  log(`  A1 vs REAL corpus (handle-refund=${realCorpus.get("handle-refund")?.body.match(/^\d+\. /gm)?.length ?? "?"} numbered steps): rate ${a1.followedCount}/${a1.applicableCount} (oracle-forced false — wiring check only; see prove-fixes.ts for the real-model positive proof).`);

  // A2: score against a tractable mini-corpus — the POSITIVE path.
  const miniHandleRefund = proc(
    "handle-refund",
    `# Handle Refund
## Procedure
1. Read the original charge to confirm the amount.
2. Issue the refund by running the refund command for that charge.
3. Record the reason and confirm the refund is settled.
## Hand-off
After the steps above are complete, follow procedure \`reconcile-invoice\` so the ledger agrees.`,
    { links: ["reconcile-invoice"], title: "Handle Refund" },
  );
  const miniReconcile = proc(
    "reconcile-invoice",
    `# Reconcile Invoice
## Procedure
1. Read the ledger lines for the affected reference.
2. Post the adjusting entry so the balance reflects the refund.
3. Confirm the line items and balance agree.`,
    { title: "Reconcile Invoice" },
  );
  const a2 = await scoreAdherence({
    turns,
    applicable,
    corpus: miniCorpus([miniHandleRefund, miniReconcile]),
    chains,
    strategy: "h1",
    floor: false,
    llm: oracle({ "handle-refund": true, "reconcile-invoice": true }),
  });
  log(`  A2 vs tractable mini-corpus (POSITIVE path): rate ${a2.followedCount}/${a2.applicableCount}`);
  for (const p of a2.perProcedure) {
    log(`     - ${p.id.padEnd(18)} followed=${p.followed} chain=${p.transitiveChainFollowed === null ? "n/a" : p.transitiveChainFollowed} attribution=${p.attribution} surfaced=${p.surfaced}`);
  }
  const a2Ok = a2.adherenceRate === 1 && a2.perProcedure.find((p) => p.id === "handle-refund")?.transitiveChainFollowed === true;
  log(`  LEG A verdict: floor passes + on-disk read intact + positive path scores 2/2 with chain=true -> ${a2Ok ? "PASS" : "FAIL"}`);

  // ---- Leg B: instrument excludes an errored run (AC8 / F14) ----
  log("\nLEG B — instrument excludes errored/auth-failed turns (never scored followed=false)");
  const errWork = join(SMOKE_DIR, "errored");
  writeCannedSubstrate(errWork, "rotate the signing credential now", [
    systemInit(),
    assistantText("Invalid API key · Please run /login. (Not logged in)"),
    resultLine(true),
  ]);
  const errTurns = readSubstrate(errWork);
  const acct = classifyRun(errTurns);
  log(`  classifyRun: total=${acct.total} excluded=${acct.excluded} hardError=${acct.hardError}`);
  log(`  reasons: ${acct.reasons.map((r) => `${r.kind}@${r.index}`).join(", ")}`);
  const legB = acct.hardError && acct.excluded >= 1;
  log(`  LEG B verdict: errored run flagged hardError + excluded (not measured) -> ${legB ? "PASS" : "FAIL"}`);

  // ---- Leg C: hook-lib unit exercise (retrieval deterministic; Haiku best-effort) ----
  log("\nLEG C — hook-lib: BM25 retrieval + a real Haiku compile probe");
  const lib = await import("./strategies/hooks-lib.mjs");
  const corpusLite = lib.loadCorpus(join(HERE, "corpus"));
  const targetHits = lib.retrieve(contextLoadScenario.targetMoment, corpusLite, 8).map((h: { id: string }) => h.id);
  const targetInTopK = targetHits.includes(contextLoadScenario.targetProcedure);
  log(`  retrieve(target) top8: ${targetHits.join(", ")}`);
  log(`  target '${contextLoadScenario.targetProcedure}' in candidates: ${targetInTopK}`);
  const distinct = contextLoadScenario.distractors.map((d) => {
    const top = lib.retrieve(d.text, corpusLite, 5).map((h: { id: string }) => h.id);
    const mapsToTarget = top.some((id: string) => applicable.includes(id));
    return { family: d.matchesFamily.split(" ")[0], top: top.slice(0, 3), mapsToTarget };
  });
  for (const d of distinct) log(`  distractor -> ${d.family.padEnd(12)} top3=[${d.top.join(", ")}] collidesWithTarget=${d.mapsToTarget}`);
  const distinctOk = distinct.every((d) => !d.mapsToTarget);

  // Real Haiku compile probe (best-effort — reported, not required for the smoke).
  let compileProbe = "skipped";
  try {
    const cand = lib.retrieve(contextLoadScenario.targetMoment, corpusLite, 5);
    const res = await lib.callHaiku(lib.buildCompileSystem(), lib.buildCompileUser(contextLoadScenario.targetMoment, cand), { maxTokens: 400 });
    compileProbe = res.ok
      ? `200, sheet mentions target=${/handle-refund/i.test(res.text)} (len ${res.text.length})`
      : `unavailable (status ${res.status}: ${res.error})`;
  } catch (e) {
    compileProbe = `error: ${(e as Error).message.slice(0, 80)}`;
  }
  log(`  Haiku compile probe: ${compileProbe}`);
  log(`  LEG C verdict: target in top-K=${targetInTopK} + distractors distinct=${distinctOk} -> ${targetInTopK && distinctOk ? "PASS" : "FAIL"}`);

  // ---- overall ----
  const pass = floorOk.ok && a2Ok && legB && targetInTopK && distinctOk;
  log("\n================ OFFLINE SMOKE verdict ================");
  log(`  A on-disk tee->floor->judge (positive path) . ${floorOk.ok && a2Ok ? "PASS" : "FAIL"}`);
  log(`  B instrument excludes errored run ............ ${legB ? "PASS" : "FAIL"}`);
  log(`  C hook-lib retrieval (evasive target in K) ... ${targetInTopK && distinctOk ? "PASS" : "FAIL"}`);
  log(`\nOFFLINE SMOKE: ${pass ? "PASS — the increment-2 pipeline is wired correctly end-to-end" : "FAIL — see legs above"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
