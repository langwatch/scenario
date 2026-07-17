/**
 * run-h2 — ONE live H2 session on the SAME scenario the head-to-head used
 * (`context-load-refund`), directly comparable to H1 (0.0) and baseline (0.5).
 *
 * H2 = H1's Haiku compile (UNCHANGED) + a BLOCKING mechanical Stop hook with
 * mandatory retry (`strategies/h2.ts` + `hooks-lib.mjs` mode `h2-verify`). The
 * hypothesis is the COMPLIANCE GAP: H1's misses were `agent-override` (the subject
 * SAW the compiled sheet but didn't finish), so H2 adds EXTERNAL ENFORCEMENT — the
 * Stop hook audits the tee'd action log for step-coverage and blocks the stop
 * (re-injecting the missing steps) until the applicable procedures are complete OR
 * the retry cap (3) is hit.
 *
 * Judge: OpenAI `gpt-5.1` ONLY (asserted non-Anthropic — the shared Max bucket is
 * reserved for the subject + the compile hook). The subject is a sandboxed
 * `claude -p` (Max OAuth); the compile hook is the only Haiku draw.
 *
 * ANTI-DORMANCY: run this SYNCHRONOUSLY in the foreground under a hard `timeout`
 * (the blocking retries make the target turn longer). It checkpoints to disk
 * immediately and on abort, so a throttle/timeout still leaves a record.
 *
 *   timeout 900 env ADHERENCE_SUBJECT_TIMEOUT_MS=360000 tsx run-h2.ts
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import scenario, { ClaudeCodeAgentAdapter } from "@langwatch/scenario";
import { openai } from "@ai-sdk/openai";

import { buildSandbox, applyChildEnv } from "./sandbox.ts";
import { loadCorpus } from "./corpus-loader.ts";
import { AdherenceJudge } from "./judge.ts";
import { callModel, defaultCredsPath } from "./judge-core.ts";
import { readSubstrate } from "./tee-substrate.ts";
import { extractActionLog } from "./normalize.ts";
import {
  classifyRun,
  readHookLog,
  summarizeHooks,
  summarizeH2,
  checkpoint,
  type SessionCheckpoint,
} from "./instrument.ts";
import {
  contextLoadScenario,
  scenarioTurns,
  seedProject,
  assertDescriptionClean,
} from "./scenarios/context-load.ts";
import type { FloorOpts } from "./run-shape-floor.ts";

const JUDGE_MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? "gpt-5.1";
const RETRY_CAP = Number(process.env.ADHERENCE_RETRY_CAP ?? 3) || 3;
const CREDS = defaultCredsPath();
// The blocking retries lengthen the target turn; default generously (6 min/turn).
const SUBJECT_TIMEOUT_MS = Number(process.env.ADHERENCE_SUBJECT_TIMEOUT_MS ?? 360_000);

const FLOOR: FloorOpts = {
  id: contextLoadScenario.id,
  minTurns: 5,
  requireHumanTurn: true,
  requireToolUse: true,
  requireActionEvidence: true,
};

function log(...a: unknown[]): void {
  console.log(...a);
}

/** Load OPENAI_API_KEY at runtime from a gitignored scenario .env (never committed). */
function loadOpenAIKey(): string | undefined {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const envPath =
    process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";
  try {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("OPENAI_API_KEY="));
    const key = line?.slice("OPENAI_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
    if (key) process.env.OPENAI_API_KEY = key;
    return key;
  } catch {
    return undefined;
  }
}

async function runFull(openaiKey: string | undefined): Promise<void> {
  const corpus = loadCorpus();
  const turns = scenarioTurns();
  let actualJudgeModel = JUDGE_MODEL;

  const sandbox = buildSandbox("h2", {
    applicable: contextLoadScenario.applicable,
    retryCap: RETRY_CAP,
  });
  const seeded = seedProject(sandbox.projectDir);
  log(`sandbox ............. ${sandbox.root}`);
  log(`  creds symlink realpath (outside repo): ${sandbox.credsRealpath}`);
  log(`  seeded project state: ${seeded.join(", ")}`);
  log(`  hooks: ${Object.keys(sandbox.strategy.hooks).join(", ")}  (Stop = h2-verify BLOCKING, cap=${RETRY_CAP})`);
  log(`  enforced applicable set: [${contextLoadScenario.applicable.join(", ")}]`);

  // Pre-write a running checkpoint so an abort still leaves a record on disk.
  checkpoint(join(sandbox.root, "checkpoint.json"), {
    scenarioId: contextLoadScenario.id,
    strategy: sandbox.strategy.name,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    configDir: sandbox.configDir,
    workDir: sandbox.workDir,
  });

  const restoreEnv = applyChildEnv(sandbox);
  try {
    const subject = new ClaudeCodeAgentAdapter({
      workingDirectory: sandbox.projectDir,
      claudeBin: sandbox.shimPath,
      timeout: SUBJECT_TIMEOUT_MS,
      logger: {
        log: () => undefined,
        warn: (...m: unknown[]) =>
          appendFileSync(join(sandbox.root, "subject-stderr.log"), m.join(" ") + "\n"),
      },
    });

    // Judge on gpt-5.1 DIRECT — never the Anthropic path (asserted).
    const judgeLlm = async (system: string, user: string, model: string): Promise<string> => {
      const out = await callModel(system, user, model, {
        credentialsPath: CREDS,
        openaiApiKey: openaiKey,
        logger: (m) => log(`   ${m}`),
      });
      actualJudgeModel = model;
      return out;
    };

    const judge = new AdherenceJudge({
      applicable: contextLoadScenario.applicable,
      corpus,
      chains: contextLoadScenario.chains,
      strategy: sandbox.strategy.name, // "h2"
      hookLogPath: sandbox.hookLog,
      workDir: sandbox.workDir,
      model: JUDGE_MODEL,
      credentialsPath: CREDS,
      openaiApiKey: openaiKey,
      floor: FLOOR,
      llm: judgeLlm,
      logger: (m) => log(`   ${m}`),
    });

    const script = [
      scenario.user(turns[0]),
      scenario.agent(),
      scenario.user(turns[1]),
      scenario.agent(),
      scenario.user(turns[2]),
      scenario.agent(),
      scenario.user(turns[3]),
      scenario.agent(),
      scenario.judge(),
    ];

    log(`\n--- FULL scenario.run (H2): ${turns.length} scripted turns, target buried last ---`);
    const result = await scenario.run({
      name: contextLoadScenario.name,
      description: contextLoadScenario.description,
      agents: [subject, scenario.userSimulatorAgent({ model: openai("gpt-5-mini") }), judge],
      script,
      setId: "spike-784-adherence",
      maxTurns: 30,
    });

    const report = judge.lastReport;
    const substrate = readSubstrate(sandbox.workDir);
    const actions = extractActionLog(substrate);
    const acct = classifyRun(substrate);
    const hookEvents = readHookLog(sandbox.hookLog);
    const hooks = summarizeHooks(hookEvents);
    const h2 = summarizeH2(hookEvents);

    const cp: SessionCheckpoint = {
      scenarioId: contextLoadScenario.id,
      strategy: sandbox.strategy.name,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: report?.belowFloor ? "excluded" : "judged",
      configDir: sandbox.configDir,
      workDir: sandbox.workDir,
      turnCounts: acct,
      hooks: { ...hooks, events: undefined } as unknown as SessionCheckpoint["hooks"],
      report,
      notes: [
        `judge model actually used: ${actualJudgeModel}`,
        `scenario.run success=${result.success}`,
        `H2 blocks=${h2.blocks} retryForcedCompletion=${h2.retryForcedCompletion} capHit=${h2.capHit}`,
        `H2 decisions=[${h2.decisions.join(", ")}]`,
      ],
    };
    checkpoint(join(sandbox.root, "checkpoint.json"), cp);

    // ---- report ----
    log(`\n================ LIVE H2 SESSION — result ================`);
    log(`scenario ............ ${contextLoadScenario.id}`);
    log(`configDir ........... ${sandbox.configDir}`);
    log(`substrate turns ..... ${substrate.length}  (accounting: total=${acct.total} excluded=${acct.excluded} hardError=${acct.hardError})`);
    log(`subject tool actions  ${actions.length} (tool_use=${actions.filter((a) => a.kind === "tool_use").length}, tool_result=${actions.filter((a) => a.kind === "tool_result").length})`);
    log(`  actions: ${actions.slice(0, 24).map((a) => (a.kind === "tool_use" ? `${a.name}(${JSON.stringify(a.input).slice(0, 34)})` : "→result")).join("  ")}`);

    log(`\nH1-compile hooks (the binding sheet): compile=${hooks.compileCalls} haiku200=${hooks.haiku200s} non200=${hooks.haikuNon200s} invalidTurns=${hooks.invalidTurns}`);
    const compiles = hookEvents.filter((e) => e.mode === "h1-compile" && e.event === "userpromptsubmit");
    for (const c of compiles) log(`  compile turn: retrieved=[${(c.retrieved ?? []).join(", ")}] compiledIds=[${(c.compiledIds ?? []).join(", ")}] haikuStatus=${c.haikuStatus}`);

    log(`\nH2 BLOCKING Stop hook (the enforcement delta):`);
    log(`  fires=${h2.fires} blocks=${h2.blocks} noopAllows=${h2.noopAllows} enforcedAtLeastOnce=${h2.enforcedAtLeastOnce}`);
    log(`  retryForcedCompletion=${h2.retryForcedCompletion} capHit=${h2.capHit}`);
    log(`  decision sequence: [${h2.decisions.join(", ")}]`);
    log(`  coverage trajectory (enforced fires):`);
    for (const t of h2.trajectory) {
      log(`    ${t.decision.padEnd(28)} enforced=[${t.enforced.join(", ")}] mut=${t.mutations}/${t.needMut} read=${t.reads}/${t.needRead} retry=${t.retry ?? "-"} stopHookActive=${t.stopHookActive}`);
    }

    log(`\njudge model ......... ${actualJudgeModel}`);
    if (!report) {
      log("judge report ........ (none — run may have aborted before judgment)");
    } else if (report.belowFloor) {
      log("judge report ........ EXCLUDED below run-shape floor (degenerate/aborted); not scored.");
    } else {
      log(`ADHERENCE RATE ...... ${report.followedCount}/${report.applicableCount} = ${report.adherenceRate.toFixed(2)}`);
      for (const p of report.perProcedure) {
        log(`  - ${p.id.padEnd(20)} followed=${String(p.followed).padEnd(5)} chain=${p.transitiveChainFollowed === null ? "n/a" : String(p.transitiveChainFollowed)} attribution=${p.attribution} surfaced=${p.surfaced}`);
        log(`      reasoning: ${p.reasoning}`);
      }
    }
    log(`\ncomparison .......... baseline=0.50  H1=0.00  H2=${report && !report.belowFloor ? report.adherenceRate.toFixed(2) : "n/a"}`);
    log(`checkpoint .......... ${join(sandbox.root, "checkpoint.json")}`);
    log(`scenario.run success  ${result.success}`);
  } catch (e) {
    const substrate = readSubstrate(sandbox.workDir);
    const acct = classifyRun(substrate);
    const hookEvents = readHookLog(sandbox.hookLog);
    const hooks = summarizeHooks(hookEvents);
    const h2 = summarizeH2(hookEvents);
    checkpoint(join(sandbox.root, "checkpoint.json"), {
      scenarioId: contextLoadScenario.id,
      strategy: sandbox.strategy.name,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "aborted",
      configDir: sandbox.configDir,
      workDir: sandbox.workDir,
      turnCounts: acct,
      hooks: { ...hooks, events: undefined } as unknown as SessionCheckpoint["hooks"],
      error: (e as Error).message,
      notes: [
        "run aborted; checkpoint preserved (not measured)",
        `H2 blocks=${h2.blocks} decisions=[${h2.decisions.join(", ")}]`,
      ],
    });
    log(`\n!! RUN ABORTED: ${(e as Error).message}`);
    log(`   substrate captured so far: ${substrate.length} turns; excluded=${acct.excluded} hardError=${acct.hardError}`);
    log(`   H2 blocks before abort: ${h2.blocks}; decisions=[${h2.decisions.join(", ")}]`);
    log(`   checkpoint preserved at ${join(sandbox.root, "checkpoint.json")} (status=aborted, NOT measured)`);
    process.exitCode = 3;
  } finally {
    restoreEnv();
  }
}

async function main(): Promise<void> {
  const openaiKey = loadOpenAIKey();
  log("================ #784 LIVE adherence loop — H2 (compile + BLOCKING retry) ================");
  log(`strategy ............ h2`);
  log(`judge model ......... ${JUDGE_MODEL}`);

  // Enforce "never the Anthropic path" for the JUDGE (subject/compile Haiku are inherent).
  if (/^claude/i.test(JUDGE_MODEL)) {
    throw new Error(`H2 must judge on OpenAI gpt-5.1, never the Anthropic path; got JUDGE_MODEL=${JUDGE_MODEL}`);
  }
  if (!openaiKey) {
    throw new Error("No OPENAI_API_KEY available (checked env + scenario .env); the gpt-5.1 judge cannot run.");
  }

  // Guard the description before it reaches the user-sim system prompt (#705).
  const allIds = [...loadCorpus().keys()];
  assertDescriptionClean(contextLoadScenario.description, allIds);
  log(`description leak-check PASS (procedure-agnostic; ${allIds.length} ids checked)`);
  log(`subject per-turn timeout: ${SUBJECT_TIMEOUT_MS}ms; retry cap: ${RETRY_CAP}`);

  await runFull(openaiKey);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
