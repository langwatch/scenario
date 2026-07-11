/**
 * run-h3 — ONE live H3 session on the SAME scenario the head-to-head used
 * (`context-load-refund`), directly comparable to baseline (0.5), H1 (0.0), and
 * H2 (0.5).
 *
 * H3 = H1's Haiku compile (UNCHANGED) + a BLOCKING Stop hook whose completion
 * criterion is PER-PROCEDURE and ≡ THE JUDGE (`strategies/h3.ts` + `hooks-lib.mjs`
 * mode `h3-verify`). The mutation over H2: H2's Stop gate aggregated action
 * *types* across the enforced set (`mut≥Σ AND read≥Σ`), so heavy work on
 * `handle-refund` alone satisfied the SET threshold while the transitive hand-off
 * `reconcile-invoice` was skipped — the gate ALLOWED the stop and the per-procedure
 * gpt-5.1 judge later caught the miss (H2 NEGATIVE). H3 runs one action-log
 * `followed` check PER enforced procedure at each Stop — the SAME action-only
 * judgment `judge-core` runs — and BLOCKS on ANY `followed=false`, so gate-pass ≡
 * judge-pass by construction: a well-served procedure can no longer mask a skipped
 * one. Confound controlled: `reconcile-invoice`'s artifacts (invoice +
 * reconciliation report + settlement flag) are now SEEDED so the forced retry is
 * satisfiable rather than cap-hit.
 *
 * Judge: OpenAI `gpt-5.1` ONLY (asserted non-Anthropic). The per-procedure Stop
 * gate ALSO runs on gpt-5.1 (OpenAI), never the shared Max bucket — so H3 draws
 * the SAME Anthropic bucket as H2 (one compile Haiku call per turn + the subject
 * session). The retry loop costs only the SUBJECT's own continued-turn tokens.
 *
 * ANTI-DORMANCY: run SYNCHRONOUSLY in the foreground under a hard `timeout` (the
 * blocking retries + per-proc OpenAI round-trips make the target turn longer). It
 * checkpoints to disk immediately and on abort, so a throttle/timeout still leaves
 * a record.
 *
 *   timeout 1200 env ADHERENCE_SUBJECT_TIMEOUT_MS=420000 tsx run-h3.ts
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
  summarizeH3,
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

const JUDGE_MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? "gpt-5.1";
const RETRY_CAP = Number(process.env.ADHERENCE_RETRY_CAP ?? 3) || 3;
const CREDS = defaultCredsPath();
// The blocking retries + per-proc OpenAI round-trips lengthen the target turn;
// default generously (7 min/turn).
const SUBJECT_TIMEOUT_MS = Number(process.env.ADHERENCE_SUBJECT_TIMEOUT_MS ?? 420_000);
// The gitignored .env whose PATH (never value) is baked into the Stop hook so it
// can read OPENAI_API_KEY for the per-procedure gate. Same file the runner's
// final judge loads from.
const OPENAI_ENV_PATH =
  process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";

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
  try {
    const line = readFileSync(OPENAI_ENV_PATH, "utf8")
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
  const turns = scenarioTurns(contextLoadScenario);
  let actualJudgeModel = JUDGE_MODEL;

  const sandbox = buildSandbox("h3", {
    applicable: contextLoadScenario.applicable,
    retryCap: RETRY_CAP,
    judgeModel: JUDGE_MODEL,
    openaiEnvPath: OPENAI_ENV_PATH,
  });
  const seeded = seedProject(sandbox.projectDir);
  log(`sandbox ............. ${sandbox.root}`);
  log(`  creds symlink realpath (outside repo): ${sandbox.credsRealpath}`);
  log(`  seeded project state: ${seeded.join(", ")}`);
  log(`  hooks: ${Object.keys(sandbox.strategy.hooks).join(", ")}  (Stop = h3-verify PER-PROCEDURE gate ≡ judge on ${JUDGE_MODEL}, cap=${RETRY_CAP})`);
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
      strategy: sandbox.strategy.name, // "h3"
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

    log(`\n--- FULL scenario.run (H3): ${turns.length} scripted turns, target buried last ---`);
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
    const h3 = summarizeH3(hookEvents);

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
        `H3 blocks=${h3.blocks} retryForcedCompletion=${h3.retryForcedCompletion} capHit=${h3.capHit}`,
        `H3 judgeCalls=${h3.judgeCalls} judgeErrors=${h3.judgeErrors} enforcedAtLeastOnce=${h3.enforcedAtLeastOnce}`,
        `H3 decisions=[${h3.decisions.join(", ")}]`,
      ],
    };
    checkpoint(join(sandbox.root, "checkpoint.json"), cp);

    // ---- report ----
    log(`\n================ LIVE H3 SESSION — result ================`);
    log(`scenario ............ ${contextLoadScenario.id}`);
    log(`configDir ........... ${sandbox.configDir}`);
    log(`substrate turns ..... ${substrate.length}  (accounting: total=${acct.total} excluded=${acct.excluded} hardError=${acct.hardError})`);
    log(`subject tool actions  ${actions.length} (tool_use=${actions.filter((a) => a.kind === "tool_use").length}, tool_result=${actions.filter((a) => a.kind === "tool_result").length})`);
    log(`  actions: ${actions.slice(0, 24).map((a) => (a.kind === "tool_use" ? `${a.name}(${JSON.stringify(a.input).slice(0, 34)})` : "→result")).join("  ")}`);

    log(`\nH1-compile hooks (the binding sheet): compile=${hooks.compileCalls} haiku200=${hooks.haiku200s} non200=${hooks.haikuNon200s} invalidTurns=${hooks.invalidTurns}`);
    const compiles = hookEvents.filter((e) => e.mode === "h1-compile" && e.event === "userpromptsubmit");
    for (const c of compiles) log(`  compile turn: retrieved=[${(c.retrieved ?? []).join(", ")}] compiledIds=[${(c.compiledIds ?? []).join(", ")}] haikuStatus=${c.haikuStatus}`);

    log(`\nH3 PER-PROCEDURE Stop gate ≡ judge (the enforcement delta):`);
    log(`  fires=${h3.fires} blocks=${h3.blocks} noopAllows=${h3.noopAllows} enforcedAtLeastOnce=${h3.enforcedAtLeastOnce}`);
    log(`  retryForcedCompletion=${h3.retryForcedCompletion} capHit=${h3.capHit}`);
    log(`  per-proc gate cost (OpenAI, bucket-free): judgeCalls=${h3.judgeCalls} judgeErrors=${h3.judgeErrors}`);
    log(`  decision sequence: [${h3.decisions.join(", ")}]`);
    log(`  per-procedure trajectory (enforced fires):`);
    for (const t of h3.trajectory) {
      const verdicts = t.perProc
        .map((p) => `${p.id}=${p.followed === null ? "err" : p.followed}${p.judgeOk ? "" : "!"}`)
        .join(" ");
      log(`    ${t.decision.padEnd(28)} enforced=[${t.enforced.join(", ")}] blocked=[${t.blockedProcs.join(", ")}] retry=${t.retry ?? "-"} verdicts={${verdicts}} stopHookActive=${t.stopHookActive}`);
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
    log(`\ncomparison .......... baseline=0.50  H1=0.00  H2=0.50  H3=${report && !report.belowFloor ? report.adherenceRate.toFixed(2) : "n/a"}`);
    log(`checkpoint .......... ${join(sandbox.root, "checkpoint.json")}`);
    log(`scenario.run success  ${result.success}`);
  } catch (e) {
    const substrate = readSubstrate(sandbox.workDir);
    const acct = classifyRun(substrate);
    const hookEvents = readHookLog(sandbox.hookLog);
    const hooks = summarizeHooks(hookEvents);
    const h3 = summarizeH3(hookEvents);
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
        `H3 blocks=${h3.blocks} decisions=[${h3.decisions.join(", ")}]`,
      ],
    });
    log(`\n!! RUN ABORTED: ${(e as Error).message}`);
    log(`   substrate captured so far: ${substrate.length} turns; excluded=${acct.excluded} hardError=${acct.hardError}`);
    log(`   H3 blocks before abort: ${h3.blocks}; decisions=[${h3.decisions.join(", ")}]`);
    log(`   checkpoint preserved at ${join(sandbox.root, "checkpoint.json")} (status=aborted, NOT measured)`);
    process.exitCode = 3;
  } finally {
    restoreEnv();
  }
}

async function main(): Promise<void> {
  const openaiKey = loadOpenAIKey();
  log("================ #784 LIVE adherence loop — H3 (compile + PER-PROCEDURE gate ≡ judge) ================");
  log(`strategy ............ h3`);
  log(`judge model ......... ${JUDGE_MODEL}`);

  // Enforce "never the Anthropic path" for the JUDGE + the per-proc gate.
  if (/^claude/i.test(JUDGE_MODEL)) {
    throw new Error(`H3 must judge on OpenAI gpt-5.1, never the Anthropic path; got JUDGE_MODEL=${JUDGE_MODEL}`);
  }
  if (!openaiKey) {
    throw new Error(
      "No OPENAI_API_KEY available (checked env + scenario .env); the gpt-5.1 judge AND the per-procedure Stop gate cannot run — the gate would fail OPEN and H3 would silently degrade to H1-compile-only.",
    );
  }

  // Guard the description before it reaches the user-sim system prompt (#705).
  const allIds = [...loadCorpus().keys()];
  assertDescriptionClean(contextLoadScenario.description, allIds);
  log(`description leak-check PASS (procedure-agnostic; ${allIds.length} ids checked)`);
  log(`subject per-turn timeout: ${SUBJECT_TIMEOUT_MS}ms; retry cap: ${RETRY_CAP}`);
  log(`per-procedure gate .. gpt-5.1 (OpenAI, bucket-free); openaiEnvPath=${OPENAI_ENV_PATH}`);

  await runFull(openaiKey);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
