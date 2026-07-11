/**
 * run-prove — the LIVE head-to-head for the improvised/rubric variant
 * (`context-load-prove`). ONE session per arm, DUAL-SCORED:
 *   - the ACTION judge (AdherenceJudge, gpt-5.1) scores `prove-finding` from action
 *     presence — did the subject enact the lookup (read the reference/decision) and
 *     write the finding. This is the ACTION half (also what the H4 Stop gate ≡).
 *   - the RUBRIC judge (rubric-core `scoreRubric`, gpt-5.1) scores the produced
 *     ARTIFACT's OUTPUT QUALITY against RCA_RUBRIC (proven on fixtures in
 *     prove-rubric.ts). This is the QUALITY half the action judge is BLIND to.
 *
 * THE QUESTION (recipe boundary): does compile+gate (H4) change the rubric SCORE vs
 * baseline, and does the gate ever fire on the QUALITY step or only on the lookup
 * action? The action gate can enforce that a finding was WRITTEN + the reference was
 * READ, but any Write satisfies "wrote the finding" — so on the quality dimension it
 * is structurally a no-op (rubber-stamp). This run measures whether the COMPILE
 * (making the quality bar binding) moves quality, and observes the gate trajectory.
 *
 * Arms via ADHERENCE_STRATEGY: `baseline` (fair retrieval, no compile, no gate) vs
 * `h3` (= H4: compile + per-procedure BLOCKING Stop gate, transitively scoped).
 * Judge + rubric + gate all on OpenAI gpt-5.1 (asserted non-Anthropic — the subject
 * is Claude). Run under a hard timeout; checkpoints on disk + on abort.
 *
 *   ADHERENCE_STRATEGY=baseline timeout -k 60 1200 tsx run-prove.ts
 *   ADHERENCE_STRATEGY=h3       timeout -k 60 1200 tsx run-prove.ts
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import scenario, { ClaudeCodeAgentAdapter } from "@langwatch/scenario";
import { openai } from "@ai-sdk/openai";

import { buildSandbox, applyChildEnv, type Sandbox, type StrategyName } from "./sandbox.ts";
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
  extractSubjectModel,
  checkpoint,
  type SessionCheckpoint,
} from "./instrument.ts";
import { contextLoadProveScenario, seedProveProject } from "./scenarios/context-load-prove.ts";
import { scenarioTurns, assertDescriptionClean } from "./scenarios/context-load.ts";
import { scoreRubric, type RubricResult } from "./rubric-core.ts";
import { RCA_RUBRIC, proveSourceMaterial, PROVE_ARTIFACT_REL, PROVE_SEED_FILES } from "./prove-world.ts";
import type { NormalizedTurn } from "./types.ts";
import type { FloorOpts } from "./run-shape-floor.ts";

const STRATEGY = (process.env.ADHERENCE_STRATEGY as StrategyName) ?? "baseline";
const JUDGE_MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? "gpt-5.1";
const RUBRIC_MODEL = process.env.ADHERENCE_RUBRIC_MODEL ?? "gpt-5.1";
const RETRY_CAP = Number(process.env.ADHERENCE_RETRY_CAP ?? 3) || 3;
const CREDS = defaultCredsPath();
const SUBJECT_TIMEOUT_MS = Number(process.env.ADHERENCE_SUBJECT_TIMEOUT_MS ?? 420_000);
const OPENAI_ENV_PATH =
  process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";

const FLOOR: FloorOpts = {
  id: contextLoadProveScenario.id,
  minTurns: 5,
  requireHumanTurn: true,
  requireToolUse: true,
  requireActionEvidence: true,
};

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SEEDED = new Set(PROVE_SEED_FILES.map((f) => f.rel));

function log(...a: unknown[]): void {
  console.log(...a);
}

/** Load OPENAI_API_KEY at runtime from a gitignored scenario .env (never committed). */
function loadOpenAIKey(): string | undefined {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const line = readFileSync(OPENAI_ENV_PATH, "utf8").split("\n").find((l) => l.startsWith("OPENAI_API_KEY="));
    const key = line?.slice("OPENAI_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
    if (key) process.env.OPENAI_API_KEY = key;
    return key;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the produced artifact for rubric scoring. Prefer the expected path the
 * procedure/incident name (`state/analysis-4471.md`); else the LAST subject-written
 * markdown file that is NOT a seeded file (so the seeded decision record is never
 * mistaken for the artifact). Reads final on-disk state; falls back to the Write's
 * own content if the file cannot be read.
 */
function resolveArtifact(
  substrate: NormalizedTurn[],
  projectDir: string,
): { path: string; text: string; source: string } {
  const expected = join(projectDir, PROVE_ARTIFACT_REL);
  if (existsSync(expected)) {
    try {
      const text = readFileSync(expected, "utf8");
      if (text.trim()) return { path: expected, text, source: "expected-path" };
    } catch {
      /* fall through */
    }
  }
  // Scan subject Writes for a non-seeded markdown artifact (last wins).
  let picked: { path: string; content: string } | undefined;
  for (const t of substrate) {
    for (const tu of t.toolUses) {
      if (!WRITE_TOOLS.has(tu.name)) continue;
      const inp = tu.input as { file_path?: unknown; notebook_path?: unknown; content?: unknown };
      const fp = typeof inp.file_path === "string" ? inp.file_path : typeof inp.notebook_path === "string" ? inp.notebook_path : "";
      if (!fp) continue;
      const rel = fp.startsWith(projectDir) ? fp.slice(projectDir.length).replace(/^\/+/, "") : fp;
      if (SEEDED.has(rel)) continue; // never the seeded decision record
      const looksLikeFinding = /\.md$/i.test(fp) || /(analysis|finding|rca|root|incident)/i.test(fp);
      if (!looksLikeFinding) continue;
      picked = { path: fp, content: typeof inp.content === "string" ? inp.content : "" };
    }
  }
  if (picked) {
    if (existsSync(picked.path)) {
      try {
        const text = readFileSync(picked.path, "utf8");
        if (text.trim()) return { path: picked.path, text, source: "substrate-write(disk)" };
      } catch {
        /* fall through to content */
      }
    }
    if (picked.content.trim()) return { path: picked.path, text: picked.content, source: "substrate-write(content)" };
  }
  return { path: expected, text: "", source: "not-found" };
}

async function runFull(openaiKey: string | undefined): Promise<void> {
  const corpus = loadCorpus();
  const turns = scenarioTurns(contextLoadProveScenario);
  const isH4 = STRATEGY === "h3";
  let actualJudgeModel = JUDGE_MODEL;

  const sandbox: Sandbox = isH4
    ? buildSandbox("h3", {
        applicable: contextLoadProveScenario.applicable,
        retryCap: RETRY_CAP,
        judgeModel: JUDGE_MODEL,
        openaiEnvPath: OPENAI_ENV_PATH,
      })
    : buildSandbox(STRATEGY);

  const seeded = seedProveProject(sandbox.projectDir);
  log(`sandbox ............. ${sandbox.root}`);
  log(`  strategy .......... ${sandbox.strategy.name}${isH4 ? "  (H4: compile + per-procedure BLOCKING Stop gate ≡ judge)" : "  (baseline: fair retrieval, no compile, no gate)"}`);
  log(`  seeded project state: ${seeded.join(", ")}`);
  log(`  hooks: ${Object.keys(sandbox.strategy.hooks).join(", ") || "(none)"}`);
  log(`  enforced applicable set: [${contextLoadProveScenario.applicable.join(", ")}]  artifact=${PROVE_ARTIFACT_REL}`);

  checkpoint(join(sandbox.root, "checkpoint.json"), {
    scenarioId: contextLoadProveScenario.id,
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
        warn: (...m: unknown[]) => appendFileSync(join(sandbox.root, "subject-stderr.log"), m.join(" ") + "\n"),
      },
    });

    // Judge on gpt-5.1 DIRECT — never the Anthropic path.
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
      applicable: contextLoadProveScenario.applicable,
      corpus,
      chains: contextLoadProveScenario.chains,
      strategy: sandbox.strategy.name,
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

    log(`\n--- FULL scenario.run (${sandbox.strategy.name}): ${turns.length} scripted turns, judgment target buried last ---`);
    const result = await scenario.run({
      name: contextLoadProveScenario.name,
      description: contextLoadProveScenario.description,
      agents: [subject, scenario.userSimulatorAgent({ model: openai("gpt-5-mini") }), judge],
      script,
      setId: "spike-784-adherence",
      maxTurns: 30,
    });

    const report = judge.lastReport;
    const substrate = readSubstrate(sandbox.workDir);
    const actions = extractActionLog(substrate);
    const subjectModel = extractSubjectModel(substrate).join(",") || "unknown";
    const acct = classifyRun(substrate);
    const hookEvents = readHookLog(sandbox.hookLog);
    const hooks = summarizeHooks(hookEvents);
    const h3 = summarizeH3(hookEvents);

    // ---- RUBRIC scoring (the quality half the action judge cannot see) ----
    const art = resolveArtifact(substrate, sandbox.projectDir);
    let rubric: RubricResult | undefined;
    if (!report || report.belowFloor) {
      log(`\n[rubric] run below floor / no report — skipping rubric scoring.`);
    } else {
      log(`\n[rubric] scoring artifact (${art.source}: ${art.path}) — ${art.text.length} chars`);
      rubric = await scoreRubric({
        artifact: art.text,
        sourceMaterial: proveSourceMaterial(),
        rubric: RCA_RUBRIC,
        model: RUBRIC_MODEL,
        openaiApiKey: openaiKey,
        logger: (m) => log(`   ${m}`),
      });
    }

    const cp: SessionCheckpoint = {
      scenarioId: contextLoadProveScenario.id,
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
        `subject model resolved: ${subjectModel}`,
        `judge model actually used: ${actualJudgeModel}`,
        `scenario.run success=${result.success}`,
        `ACTION prove-finding followed=${report?.perProcedure.find((p) => p.id === "prove-finding")?.followed}`,
        `RUBRIC artifact=${art.source} score=${rubric ? `${rubric.score}/${rubric.total} passed=${rubric.passed}` : "n/a"} model=${RUBRIC_MODEL}`,
        `RUBRIC perCriterion=${rubric ? rubric.perCriterion.map((c) => `${c.id}=${c.met}`).join(" ") : "n/a"}`,
        `H4 blocks=${h3.blocks} retryForcedCompletion=${h3.retryForcedCompletion} capHit=${h3.capHit} decisions=[${h3.decisions.join(", ")}]`,
      ],
    };
    checkpoint(join(sandbox.root, "checkpoint.json"), cp);

    // ---- report ----
    log(`\n================ LIVE PROVE SESSION — ${sandbox.strategy.name.toUpperCase()} (dual-scored) ================`);
    log(`scenario ............ ${contextLoadProveScenario.id}`);
    log(`configDir ........... ${sandbox.configDir}`);
    log(`substrate turns ..... ${substrate.length}  (accounting: total=${acct.total} excluded=${acct.excluded} hardError=${acct.hardError})`);
    log(`subject tool actions  ${actions.length} (tool_use=${actions.filter((a) => a.kind === "tool_use").length}, tool_result=${actions.filter((a) => a.kind === "tool_result").length})`);
    log(`  actions: ${actions.slice(0, 24).map((a) => (a.kind === "tool_use" ? `${a.name}(${JSON.stringify(a.input).slice(0, 34)})` : "→result")).join("  ")}`);

    log(`\ncompile hooks (H4 only): compile=${hooks.compileCalls} haiku200=${hooks.haiku200s} non200=${hooks.haikuNon200s}`);
    const compiles = hookEvents.filter((e) => e.mode === "h1-compile" && e.event === "userpromptsubmit");
    for (const c of compiles) log(`  compile turn: retrieved=[${(c.retrieved ?? []).join(", ")}] compiledIds=[${(c.compiledIds ?? []).join(", ")}] haikuStatus=${c.haikuStatus}`);

    if (isH4) {
      log(`\nH4 PER-PROCEDURE Stop gate ≡ judge (does it fire on the LOOKUP action, or on QUALITY?):`);
      log(`  fires=${h3.fires} blocks=${h3.blocks} noopAllows=${h3.noopAllows} retryForcedCompletion=${h3.retryForcedCompletion} capHit=${h3.capHit}`);
      log(`  per-proc gate cost (OpenAI): judgeCalls=${h3.judgeCalls} judgeErrors=${h3.judgeErrors}`);
      log(`  decision sequence: [${h3.decisions.join(", ")}]`);
      for (const t of h3.trajectory) {
        const verdicts = t.perProc.map((p) => `${p.id}=${p.followed === null ? "err" : p.followed}`).join(" ");
        log(`    ${t.decision.padEnd(28)} enforced=[${t.enforced.join(", ")}] blocked=[${t.blockedProcs.join(", ")}] retry=${t.retry ?? "-"} verdicts={${verdicts}}`);
      }
    }

    log(`\nsubject model ....... ${subjectModel}  (claude -p resolved — logged variable)`);
    log(`judge model ......... ${actualJudgeModel}`);
    log(`\n--- ACTION half (lookup + write presence; = the H4 gate's view) ---`);
    if (!report) {
      log("action report ....... (none — run may have aborted before judgment)");
    } else if (report.belowFloor) {
      log("action report ....... EXCLUDED below run-shape floor; not scored.");
    } else {
      log(`action adherence .... ${report.followedCount}/${report.applicableCount} = ${report.adherenceRate.toFixed(2)}`);
      for (const p of report.perProcedure) {
        log(`  - ${p.id.padEnd(16)} followed=${String(p.followed).padEnd(5)} attribution=${p.attribution} surfaced=${p.surfaced}`);
        log(`      reasoning: ${p.reasoning}`);
      }
    }

    log(`\n--- QUALITY half (the RUBRIC judge — what the action gate is BLIND to) ---`);
    if (!rubric) {
      log("rubric .............. n/a");
    } else {
      log(`artifact ............ ${art.source}: ${art.path}`);
      log(`RUBRIC SCORE ........ ${rubric.score}/${rubric.total}  passed=${rubric.passed}  (threshold ${RCA_RUBRIC.passThreshold}) model=${rubric.model}`);
      for (const c of rubric.perCriterion) log(`  - ${c.id.padEnd(24)} met=${String(c.met).padEnd(5)} ${c.reasoning}`);
    }

    log(`\ncheckpoint .......... ${join(sandbox.root, "checkpoint.json")}`);
    log(`scenario.run success  ${result.success}`);
  } catch (e) {
    const substrate = readSubstrate(sandbox.workDir);
    const acct = classifyRun(substrate);
    const hookEvents = readHookLog(sandbox.hookLog);
    const hooks = summarizeHooks(hookEvents);
    const h3 = summarizeH3(hookEvents);
    checkpoint(join(sandbox.root, "checkpoint.json"), {
      scenarioId: contextLoadProveScenario.id,
      strategy: sandbox.strategy.name,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "aborted",
      configDir: sandbox.configDir,
      workDir: sandbox.workDir,
      turnCounts: acct,
      hooks: { ...hooks, events: undefined } as unknown as SessionCheckpoint["hooks"],
      error: (e as Error).message,
      notes: ["run aborted; checkpoint preserved (not measured)", `H4 blocks=${h3.blocks} decisions=[${h3.decisions.join(", ")}]`],
    });
    log(`\n!! RUN ABORTED: ${(e as Error).message}`);
    log(`   substrate captured so far: ${substrate.length} turns; excluded=${acct.excluded}`);
    log(`   checkpoint preserved at ${join(sandbox.root, "checkpoint.json")} (status=aborted, NOT measured)`);
    process.exitCode = 3;
  } finally {
    restoreEnv();
  }
}

async function main(): Promise<void> {
  const openaiKey = loadOpenAIKey();
  log("================ #784 LIVE adherence loop — PROVE / RUBRIC variant (judgment work) ================");
  log(`strategy ............ ${STRATEGY}  (baseline | h3=H4)`);
  log(`action judge ........ ${JUDGE_MODEL}   rubric judge ........ ${RUBRIC_MODEL}`);

  if (/^claude/i.test(JUDGE_MODEL) || /^claude/i.test(RUBRIC_MODEL)) {
    throw new Error(`judge + rubric must run on OpenAI gpt-5.1, never the Anthropic path (the subject is Claude).`);
  }
  if (!openaiKey) {
    throw new Error(
      "No OPENAI_API_KEY (checked env + ADHERENCE_OPENAI_ENV); the gpt-5.1 action judge, the rubric judge, and (for h3) the per-procedure gate cannot run.",
    );
  }

  const allIds = [...loadCorpus().keys()];
  assertDescriptionClean(contextLoadProveScenario.description, allIds);
  log(`description leak-check PASS (procedure-agnostic; ${allIds.length} ids checked)`);
  log(`subject per-turn timeout: ${SUBJECT_TIMEOUT_MS}ms; retry cap: ${RETRY_CAP}`);

  await runFull(openaiKey);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
