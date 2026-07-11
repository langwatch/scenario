/**
 * finalize-verdict — score an ALREADY-CAPTURED live substrate with the strong
 * judge and finalize the checkpoint. ZERO new subject/Anthropic sessions.
 *
 * Used when the live run captured the subject's turns but the in-run judge
 * wedged on the shared Max bucket throttling (429 storm). The subject substrate
 * is on disk (the tee'd stream-json); this reads it, gates it with the run-shape
 * floor, and scores it with a strong judge on OpenAI (gpt-5.1) so a throttled
 * Anthropic bucket cannot strand the verdict. The judge decision rule is
 * identical to the in-run judge (action-only, authored denominator).
 *
 * Run:  tsx finalize-verdict.ts [<sandboxWorkDir>]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreAdherence } from "./judge-core.ts";
import { readSubstrate } from "./tee-substrate.ts";
import { extractActionLog } from "./normalize.ts";
import { loadCorpus } from "./corpus-loader.ts";
import {
  classifyRun,
  readHookLog,
  summarizeHooks,
  collectCompiledSheetIds,
  checkpoint,
  loadCheckpoint,
  type SessionCheckpoint,
} from "./instrument.ts";
import { contextLoadScenario } from "./scenarios/context-load.ts";
import type { FloorOpts } from "./run-shape-floor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = process.argv[2] ?? join(HERE, ".sandbox", "h1-1783740882052");
const JUDGE_MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? "gpt-5.1";

const FLOOR: FloorOpts = {
  id: contextLoadScenario.id,
  minTurns: 5,
  requireHumanTurn: true,
  requireToolUse: true,
  requireActionEvidence: true,
};

function loadOpenAIKey(): string | undefined {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const envPath = process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";
  try {
    const line = readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("OPENAI_API_KEY="));
    const key = line?.slice("OPENAI_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
    if (key) process.env.OPENAI_API_KEY = key;
    return key;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const openaiKey = loadOpenAIKey();
  const log = (...a: unknown[]) => console.log(...a);

  log("================ FINALIZE VERDICT (captured substrate; 0 new CC sessions) ================");
  log(`workDir ............. ${WORK_DIR}`);
  log(`judge model ......... ${JUDGE_MODEL} (OpenAI — Anthropic bucket throttled)`);
  log(`applicable (authored denominator): ${contextLoadScenario.applicable.join(", ")}`);
  log(`chain ............... ${contextLoadScenario.chains.map((c) => c.steps.join(" -> ")).join("; ")}`);

  const turns = readSubstrate(WORK_DIR);
  const actions = extractActionLog(turns);
  const acct = classifyRun(turns);
  const hookEvents = readHookLog(join(WORK_DIR, ".claude", "adherence", "hook-events.jsonl"));
  const hooks = summarizeHooks(hookEvents);
  // #784 H1-attribution fix: every procedure id the H1 sheet named across the
  // run, so computeSurfaced doesn't misattribute a sheet-surfaced-but-skipped
  // procedure as retrieval-miss (the sheet never appears in the tee'd substrate).
  const compiledSheetIds = collectCompiledSheetIds(hookEvents);

  log(`\nsubstrate ........... ${turns.length} turns; tool_use=${actions.filter((a) => a.kind === "tool_use").length} tool_result=${actions.filter((a) => a.kind === "tool_result").length}`);
  log(`accounting .......... total=${acct.total} excluded=${acct.excluded} hardError=${acct.hardError} (denominator = authored applicable set, never per-turn)`);
  log(`H1 hooks ............ compile=${hooks.compileCalls} verify=${hooks.verifyCalls} haiku200s=${hooks.haiku200s} non200=${hooks.haikuNon200s} invalidTurns=${hooks.invalidTurns} bothHooksFired200=${hooks.bothHooksFired200}`);
  log(`H1 sheet-compiled ids (across run) . ${compiledSheetIds.join(", ") || "(none)"}`);

  const report = await scoreAdherence({
    turns,
    applicable: contextLoadScenario.applicable,
    corpus: loadCorpus(),
    chains: contextLoadScenario.chains,
    strategy: "h1",
    compiledSheetIds,
    model: JUDGE_MODEL,
    openaiApiKey: openaiKey,
    floor: FLOOR,
    logger: (m) => log(`   ${m}`),
  });

  log(`\n================ VERDICT ================`);
  if (report.belowFloor) {
    log("EXCLUDED below run-shape floor (degenerate/aborted) — not scored.");
  } else {
    log(`adherence rate ...... ${report.followedCount}/${report.applicableCount} = ${report.adherenceRate.toFixed(2)}   (judge model: ${report.model})`);
    for (const p of report.perProcedure) {
      log(`\n  procedure: ${p.id}`);
      log(`    applied ................. ${p.applied}   (authored)`);
      log(`    followed ................ ${p.followed}   (action-only evidence)`);
      log(`    transitiveChainFollowed . ${p.transitiveChainFollowed === null ? "n/a" : p.transitiveChainFollowed}`);
      log(`    surfaced ................ ${p.surfaced}`);
      log(`    attribution ............. ${p.attribution}`);
      log(`    reasoning ............... ${p.reasoning}`);
    }
  }

  const prior = loadCheckpoint(join(WORK_DIR, "checkpoint.json"));
  const cp: SessionCheckpoint = {
    scenarioId: contextLoadScenario.id,
    strategy: "h1",
    startedAt: prior?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: report.belowFloor ? "excluded" : "judged",
    configDir: prior?.configDir,
    workDir: WORK_DIR,
    turnCounts: acct,
    hooks: { ...hooks, events: undefined } as unknown as SessionCheckpoint["hooks"],
    report,
    notes: [
      `verdict finalized post-hoc from captured substrate (in-run judge wedged on Anthropic 429 storm)`,
      `judge model actually used: ${report.model}`,
      `H1 Haiku hooks: ${hooks.haiku200s} Messages-API 200s (compile ${hooks.compileCalls} + verify ${hooks.verifyCalls})`,
    ],
  };
  checkpoint(join(WORK_DIR, "checkpoint.json"), cp);
  log(`\ncheckpoint .......... ${join(WORK_DIR, "checkpoint.json")}  (status=${cp.status})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
