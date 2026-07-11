/**
 * run-live — the LIVE adherence loop for ONE session (increment 2 milestone).
 *
 * Wiring (plan §3): a sandbox is built for the chosen strategy, then a real
 * Claude Code subject is driven through the context-load scenario via
 * `scenario.run`, its RAW stream-json stdout tee'd to the substrate, and the
 * `AdherenceJudge` scores the tee'd substrate behind the run-shape floor into a
 * per-procedure `{applied, followed, transitiveChainFollowed, attribution}`
 * verdict + an adherence rate. The instrument excludes errored/throttled turns
 * and checkpoints the verdict to disk.
 *
 *   agents = [ ClaudeCodeAgentAdapter(subject, claudeBin=tee-shim),
 *              scenario.userSimulatorAgent(),   // the user seam (present in the run)
 *              AdherenceJudge ]
 *
 * The distractor + target user turns are SCRIPTED (not free-simulated) so the
 * AC4 keyword-evasion + distinct-family load are controlled and reproducible;
 * the userSimulatorAgent is wired into the agents list as the user seam.
 *
 * Modes:
 *   SMOKE=1  — drive ONE subject turn straight through the tee shim (validates
 *              sandbox + creds + hooks fire + tee capture, ~1 subject turn).
 *   (default) — the full scenario.run session + judge verdict.
 *
 * Strategy: ADHERENCE_STRATEGY=h1|baseline (default h1).
 * Judge model: ADHERENCE_JUDGE_MODEL (default claude-sonnet-4-5) with an OpenAI
 * failover so a throttled Max bucket cannot strand the verdict.
 *
 * Run:  ADHERENCE_STRATEGY=h1 tsx run-live.ts
 *       SMOKE=1 ADHERENCE_STRATEGY=h1 tsx run-live.ts
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import scenario, { ClaudeCodeAgentAdapter } from "@langwatch/scenario";
import { openai } from "@ai-sdk/openai";

import { buildSandbox, applyChildEnv, type Sandbox, type StrategyName } from "./sandbox.ts";
import { loadCorpus } from "./corpus-loader.ts";
import { AdherenceJudge } from "./judge.ts";
import { emitJudgeVerdict } from "./telemetry-judge.ts";
import { callModel, callOpenAI, defaultCredsPath } from "./judge-core.ts";
import { readSubstrate } from "./tee-substrate.ts";
import { extractActionLog } from "./normalize.ts";
import {
  classifyRun,
  readHookLog,
  extractSubjectModel,
  summarizeHooks,
  checkpoint,
  type SessionCheckpoint,
} from "./instrument.ts";
import {
  getScenarioBundle,
  scenarioTurns,
  assertDescriptionClean,
} from "./scenarios/context-load.ts";
import type { FloorOpts } from "./run-shape-floor.ts";

// Select the scenario via ADHERENCE_SCENARIO (default: context-load-refund).
// Destructured into the historic local names so the runner body is unchanged.
const { scenario: contextLoadScenario, seed: seedProject } = getScenarioBundle(
  process.env.ADHERENCE_SCENARIO,
);

const STRATEGY = (process.env.ADHERENCE_STRATEGY as StrategyName) ?? "h1";
const JUDGE_MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? "claude-sonnet-4-5";
const SMOKE = process.env.SMOKE === "1";
const CREDS = defaultCredsPath();
const SUBJECT_TIMEOUT_MS = Number(process.env.ADHERENCE_SUBJECT_TIMEOUT_MS ?? 240_000);

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

/**
 * Judge llm: primary (Sonnet via OAuth) with an OpenAI failover. The Max bucket
 * is shared and can throttle; failing the judge over keeps the verdict alive.
 * Records which provider actually answered via `onModel`.
 */
function makeJudgeLlm(
  openaiKey: string | undefined,
  onModel: (m: string) => void,
): (s: string, u: string, m: string) => Promise<string> {
  return async (system, user, model) => {
    try {
      const out = await callModel(system, user, model, {
        credentialsPath: CREDS,
        openaiApiKey: openaiKey,
        logger: (m) => log(`   ${m}`),
      });
      onModel(model);
      return out;
    } catch (e) {
      if (openaiKey && /^claude/.test(model)) {
        log(`   [judge] primary ${model} failed (${(e as Error).message.slice(0, 120)}); failing over to OpenAI gpt-5.1`);
        const out = await callOpenAI(system, user, "gpt-5.1", openaiKey, { logger: (m) => log(`   ${m}`) });
        onModel("gpt-5.1 (failover)");
        return out;
      }
      throw e;
    }
  };
}

/** SMOKE: drive ONE subject turn straight through the tee shim under the sandbox. */
function runSmoke(sandbox: Sandbox): void {
  log(`\n--- SMOKE: one subject turn through the tee shim (strategy=${sandbox.strategy.name}) ---`);
  const prompt = contextLoadScenario.targetMoment;
  const run = spawnSync(
    "bash",
    [sandbox.shimPath, "-p", "--output-format", "stream-json", "--verbose", prompt],
    {
      cwd: sandbox.projectDir,
      encoding: "utf8",
      timeout: SUBJECT_TIMEOUT_MS,
      env: { ...process.env },
    },
  );
  log(`subject exit=${run.status} signal=${run.signal ?? "-"}`);
  if (run.stderr?.trim()) log(`subject stderr (head): ${run.stderr.slice(0, 300)}`);

  const turns = readSubstrate(sandbox.workDir);
  const actions = extractActionLog(turns);
  const acct = classifyRun(turns);
  const hooks = summarizeHooks(readHookLog(sandbox.hookLog));
  log(`substrate: ${turns.length} turns; actions: ${actions.length} (tool_use=${actions.filter((a) => a.kind === "tool_use").length}, tool_result=${actions.filter((a) => a.kind === "tool_result").length})`);
  log(`accounting: total=${acct.total} excluded=${acct.excluded} hardError=${acct.hardError}`);
  log(`hooks fired: compile=${hooks.compileCalls} verify=${hooks.verifyCalls} baseline=${hooks.baselineRetrievals} haiku200=${hooks.haiku200s} non200=${hooks.haikuNon200s} invalidTurns=${hooks.invalidTurns} bothHooks200=${hooks.bothHooksFired200}`);
  log(`sample tool actions: ${actions.slice(0, 8).map((a) => (a.kind === "tool_use" ? a.name : "→result")).join(", ")}`);
}

/** FULL: scenario.run drives the multi-turn subject; the AdherenceJudge scores. */
async function runFull(sandbox: Sandbox, openaiKey: string | undefined): Promise<void> {
  const corpus = loadCorpus();
  const turns = scenarioTurns(contextLoadScenario);
  let actualJudgeModel = JUDGE_MODEL;

  const subject = new ClaudeCodeAgentAdapter({
    workingDirectory: sandbox.projectDir,
    claudeBin: sandbox.shimPath,
    timeout: SUBJECT_TIMEOUT_MS,
    logger: {
      log: () => undefined,
      warn: (...m: unknown[]) => appendFileSync(join(sandbox.root, "subject-stderr.log"), m.join(" ") + "\n"),
    },
  });

  const judge = new AdherenceJudge({
    applicable: contextLoadScenario.applicable,
    corpus,
    chains: contextLoadScenario.chains,
    strategy: sandbox.strategy.name,
    // #784 H1-attribution fix: feed the H1 hook log so a sheet-surfaced
    // procedure is not misattributed retrieval-miss (no-op for baseline, which
    // never writes h1-compile events).
    hookLogPath: sandbox.hookLog,
    workDir: sandbox.workDir,
    model: JUDGE_MODEL,
    credentialsPath: CREDS,
    openaiApiKey: openaiKey,
    floor: FLOOR,
    llm: makeJudgeLlm(openaiKey, (m) => (actualJudgeModel = m)),
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

  log(`\n--- FULL scenario.run: ${turns.length} scripted turns, target buried last ---`);
  const result = await scenario.run({
    name: contextLoadScenario.name,
    description: contextLoadScenario.description,
    agents: [subject, scenario.userSimulatorAgent({ model: openai("gpt-5-mini") }), judge],
    script,
    setId: "spike-784-adherence",
    maxTurns: 30,
  });

  // Judge already scored inside the run; harvest the richer report.
  const report = judge.lastReport;
  const substrate = readSubstrate(sandbox.workDir);
  const actions = extractActionLog(substrate);
  // Owner requirement: the resolved subject model is a LOGGED VARIABLE every run.
  const subjectModel = extractSubjectModel(substrate).join(",") || "unknown";
  const acct = classifyRun(substrate);
  const hooks = summarizeHooks(readHookLog(sandbox.hookLog));

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
    notes: [`subject model resolved: ${subjectModel}`, `judge model actually used: ${actualJudgeModel}`, `scenario.run success=${result.success}`],
  };
  checkpoint(join(sandbox.root, "checkpoint.json"), cp);

  // LangWatch judge-verdict telemetry (owner req: judge scores + reasoning shipped
  // to LangWatch, ATTACHED to the run's traces via the SAME run.id/experiment/
  // strategy/scenario resource attrs otelWiring used). FAIL-OPEN + fire-and-forget:
  // no ik-lw- key ⇒ no-op (byte-identical run); the emitter swallows any
  // failure/timeout and we re-guard here so it can NEVER fail or slow the run. The
  // checkpoint above stays authoritative; this runs only after the verdict is in.
  try {
    await emitJudgeVerdict({
      resourceAttrs: sandbox.otelResourceAttrs,
      report,
      scenarioId: contextLoadScenario.id,
      strategy: sandbox.strategy.name,
      judgeModel: actualJudgeModel,
      subjectModel,
      scenarioRunSuccess: result.success,
      status: cp.status,
    });
  } catch {
    /* best-effort telemetry — never affect the run */
  }

  // ---- report ----
  log(`\n================ LIVE ${sandbox.strategy.name.toUpperCase()} SESSION — result ================`);
  log(`scenario ............ ${contextLoadScenario.id}`);
  log(`configDir ........... ${sandbox.configDir}`);
  log(`substrate turns ..... ${substrate.length}  (accounting: total=${acct.total} excluded=${acct.excluded} hardError=${acct.hardError})`);
  log(`subject tool actions  ${actions.length} (tool_use=${actions.filter((a) => a.kind === "tool_use").length}, tool_result=${actions.filter((a) => a.kind === "tool_result").length})`);
  log(`  actions: ${actions.slice(0, 20).map((a) => (a.kind === "tool_use" ? `${a.name}(${JSON.stringify(a.input).slice(0, 40)})` : "→result")).join("  ")}`);
  log(`\nH1 hooks fired: compile=${hooks.compileCalls} verify=${hooks.verifyCalls} baseline=${hooks.baselineRetrievals}`);
  log(`  haiku 200s=${hooks.haiku200s} non-200=${hooks.haikuNon200s} invalidTurns=${hooks.invalidTurns} bothHooksFired200=${hooks.bothHooksFired200}`);
  const compiles = hooks.events.filter((e) => e.mode === "h1-compile" && e.event === "userpromptsubmit");
  for (const c of compiles) log(`  compile turn: retrieved=[${(c.retrieved ?? []).join(", ")}] haikuStatus=${c.haikuStatus}`);

  log(`\nsubject model ....... ${subjectModel}  (claude -p resolved — logged variable)`);
  log(`judge model ......... ${actualJudgeModel}`);
  if (!report) {
    log("judge report ........ (none — run may have aborted before judgment)");
  } else if (report.belowFloor) {
    log("judge report ........ EXCLUDED below run-shape floor (degenerate/aborted); not scored.");
  } else {
    log(`adherence rate ...... ${report.followedCount}/${report.applicableCount} = ${report.adherenceRate.toFixed(2)}`);
    for (const p of report.perProcedure) {
      log(`  - ${p.id.padEnd(20)} followed=${String(p.followed).padEnd(5)} chain=${p.transitiveChainFollowed === null ? "n/a" : String(p.transitiveChainFollowed)} attribution=${p.attribution} surfaced=${p.surfaced}`);
      log(`      reasoning: ${p.reasoning}`);
    }
  }
  log(`\ncheckpoint .......... ${join(sandbox.root, "checkpoint.json")}`);
  log(`scenario.run success  ${result.success}`);
}

async function main(): Promise<void> {
  const openaiKey = loadOpenAIKey();
  log("================ #784 LIVE adherence loop ================");
  log(`strategy ............ ${STRATEGY}`);
  log(`mode ................ ${SMOKE ? "SMOKE (1 turn direct)" : "FULL (scenario.run)"}`);
  log(`judge model ......... ${JUDGE_MODEL}${openaiKey ? " (+ OpenAI failover)" : " (no OpenAI failover key)"}`);

  // Guard the description before it reaches the user-sim system prompt (#705).
  const allIds = [...loadCorpus().keys()];
  assertDescriptionClean(contextLoadScenario.description, allIds);
  log(`description leak-check PASS (procedure-agnostic; ${allIds.length} ids checked)`);

  const sandbox = buildSandbox(STRATEGY);
  const seeded = seedProject(sandbox.projectDir);
  log(`sandbox ............. ${sandbox.root}`);
  log(`  creds symlink realpath (outside repo): ${sandbox.credsRealpath}`);
  log(`  seeded project state: ${seeded.join(", ")}`);
  log(`  hooks: ${Object.keys(sandbox.strategy.hooks).join(", ")}`);

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
    if (SMOKE) runSmoke(sandbox);
    else await runFull(sandbox, openaiKey);
  } catch (e) {
    // The rate-limit adapter-throw rethrows through scenario.run and aborts it;
    // the checkpoint on disk survives (F14 / scenario-agent-throw-aborts-run).
    const substrate = readSubstrate(sandbox.workDir);
    const acct = classifyRun(substrate);
    const hooks = summarizeHooks(readHookLog(sandbox.hookLog));
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
      notes: ["run aborted; checkpoint preserved (not measured)"],
    });
    log(`\n!! RUN ABORTED: ${(e as Error).message}`);
    log(`   substrate captured so far: ${substrate.length} turns; excluded=${acct.excluded} hardError=${acct.hardError}`);
    log(`   hooks fired before abort: compile=${hooks.compileCalls} verify=${hooks.verifyCalls} haiku200=${hooks.haiku200s}`);
    log(`   checkpoint preserved at ${join(sandbox.root, "checkpoint.json")} (status=aborted, NOT measured)`);
    process.exitCode = 3;
  } finally {
    restoreEnv();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
