/**
 * run-plugin-dod — Definition-of-Done proof for the procedure-adherence
 * PLUGIN itself (`/home/ubuntu/langwatch-workspace/procedure-adherence-plugin`),
 * not the experiment harness's own h3/h4-shaped mimicry of it. A real `claude -p`
 * subject, with the PLUGIN's OWN shipped hooks (`hooks/compile.sh` +
 * `hooks/gate.sh` -> `hooks/lib.mjs`) installed as its adherence hooks, run
 * against the vendor 3-hop scenario (`context-load-vendor`:
 * onboard-vendor -> provision-account -> grant-access). Goal: reproduce the
 * already-proven enforcement shape (gate BLOCKS the stop on the dropped
 * `grant-access` expiry step and FORCES it to completion — 2/2 live runs of the
 * harness's own h3+chain-closure mechanism, "H4" in FINDINGS.md) via the ACTUAL
 * shipped plugin artifact, live, for the first time.
 *
 * Adapted from `run-h3.ts` — same scaffold verbatim (buildSandbox, seeding,
 * ClaudeCodeAgentAdapter subject, the gpt-5.1 referee AdherenceJudge, the tee
 * substrate, the checkpoint pattern, the LangWatch judge-verdict emit). The
 * ONLY substantive differences:
 *   1. After buildSandbox+seed, {@link installPluginHooks} OVERWRITES
 *      `settings.json`'s `hooks` key (only that key — permissions/OTEL env
 *      stay) with the PLUGIN's own hooks, env baked into each command string
 *      (never relies on process-env propagation into the hook subprocess),
 *      single-quote-escaped — mirrors `strategies/common.ts`'s `hookCommand()`
 *      convention. The tee shim (`sandbox.shimPath`) is KEPT — the referee
 *      judge still reads the tee'd substrate; only the SUBJECT's adherence
 *      hooks change. The plugin's gate reads its action log from the Stop
 *      hook's own `transcript_path` (Claude Code's native, whole-session
 *      transcript), NOT the tee — a deliberate port difference from the
 *      harness's h3 strategy (see `hooks/lib.mjs`'s "Production hook
 *      entrypoints" section) precisely because a REAL shipped hook cannot rely
 *      on the harness's tee-shim trick. Whether that native-transcript read
 *      actually sees the subject's live actions under `claude -p`/`--resume`
 *      (vs a possible stub, per `tee-substrate.ts`'s own doc comment on why
 *      the harness avoids it) is one of the two things this run tests.
 *   2. Scenario defaults to `context-load-vendor` (still env-overridable via
 *      `ADHERENCE_SCENARIO`, same resolution mechanism as run-h3.ts) — this
 *      file's whole reason for existing is proving `grant-access`
 *      enforcement, so the default differs from run-h3.ts's (refund). Subject
 *      model defaults to `claude-haiku-4-5` (env `ADHERENCE_SUBJECT_MODEL`) to
 *      save bucket — gate parity is subject-invariant. The tee shim
 *      (`tee-substrate.ts` `teeShimSource`) already reads
 *      `ADHERENCE_SUBJECT_MODEL` from its own process env at spawn time;
 *      `applyChildEnv` never set it (H1-H3 never needed a subject-model
 *      override), so it is snapshotted/set/restored here (L5 discipline).
 *   3. DATA-FIRST retention (`salvageRunData`): immediately after
 *      `scenario.run` resolves (and first thing in the catch) — BEFORE any
 *      further processing that could itself throw — the raw, ephemeral (/tmp
 *      sandbox) artifacts are copied into the durable, git-tracked
 *      `run-data/plugin-dod/<runId>/`: the plugin's hook log, its
 *      `.procedure-adherence/state/` (compiled sheets + retry counters), the
 *      checkpoint, and the tee substrate. Same "data is gold" discipline as
 *      the #784 salvage commits (b00cd02/e3eab3a). Idempotent — called again
 *      after the FINAL checkpoint is written so the meaningful (not just the
 *      "running" stub) checkpoint lands too.
 *   4. An EVIDENCE block ({@link summarizePluginLog}): the plugin's hook-log
 *      decision sequence parsed for `decision`/`blockedProcs`/`enforcedVia`/
 *      `gateModel`. NOTE this deliberately does NOT reuse instrument.ts's
 *      `summarizeHooks`/`summarizeH3` — those filter on the HARNESS's own
 *      mode strings (`h1-compile`/`h3-verify`, from
 *      `strategies/hooks-lib.mjs`); the shipped plugin (a port of that file)
 *      logs `mode:"compile"`/`mode:"gate"` instead, so the harness
 *      summarizers would silently read this log as all-zero. Also prints the
 *      referee's final adherence rate + per-procedure `followed`, and the
 *      on-disk `state/audit-ledger.jsonl` `expires_at` field — the concrete,
 *      independently-checkable trace of `grant-access`'s forced step actually
 *      landing (mirrors `prove-claude-gate.mjs`'s canned
 *      `LOG_GRANT_DONE`/`expires_at` fixture, now observed live).
 *   5. `setId: "spike-784-adherence"` on `scenario.run` is UNCHANGED (same as
 *      run-h3.ts) so the simulation stays query-back-able; the orchestrator
 *      supplies `LANGWATCH_API_KEY` at run time.
 *
 * Bucket note: the referee stays gpt-5.1 (OpenAI, bucket-free) — asserted
 * below, exactly as H3 asserted it. The SUBJECT's gate is now Claude
 * (`claude-sonnet-4-5` by default — the plugin's shipped gate is CLAUDE-ONLY,
 * owner constraint #784, no GPT in the shipped runtime; see `hooks/lib.mjs`'s
 * `isClaudeGate` fail-open branch), authenticated via the SAME sandboxed
 * Claude Max OAuth creds symlink the subject session itself uses. This run
 * therefore draws MORE of the shared Anthropic Max bucket than H3 did (H3's
 * per-procedure gate was OpenAI/bucket-free) — the subject is on Haiku
 * specifically to offset that.
 *
 * Known caveat (does not affect the DoD claim): the referee's `surfaced`/
 * `attribution` per-procedure fields can undercount here, because
 * `collectCompiledSheetIds()` (instrument.ts) unions in ids from
 * `mode:"h1-compile"` hook-log events and the plugin logs `mode:"compile"`
 * instead — so that union is empty this run. `followed`/`adherenceRate` are
 * UNAFFECTED (computed action-log-only; `judge-core.ts:scoreAdherence`), and
 * `attribution` only matters when `followed=false` (`mapAttribution` returns
 * "none" whenever `followed=true`) — not the interesting case for the
 * forced-to-followed claim this file exists to prove.
 *
 * ANTI-DORMANCY: run SYNCHRONOUSLY in the foreground under a hard `timeout`
 * (same reasoning as H3 — blocking retries + a Sonnet gate round-trip per
 * enforced procedure lengthen the target turn). Checkpoints to disk
 * immediately and on abort, and salvages raw artifacts DATA-FIRST either way.
 *
 *   timeout 1200 env ADHERENCE_SUBJECT_TIMEOUT_MS=420000 tsx run-plugin-dod.ts
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import scenario, { ClaudeCodeAgentAdapter } from "@langwatch/scenario";
import { openai } from "@ai-sdk/openai";

import { buildSandbox, applyChildEnv, CORPUS_DIR, type Sandbox } from "./sandbox.ts";
import { loadCorpus } from "./corpus-loader.ts";
import { AdherenceJudge } from "./judge.ts";
import { emitJudgeVerdict } from "./telemetry-judge.ts";
import { callModel, defaultCredsPath } from "./judge-core.ts";
import { readSubstrate } from "./tee-substrate.ts";
import { extractActionLog } from "./normalize.ts";
import {
  classifyRun,
  readHookLog,
  extractSubjectModel,
  detectDelegation,
  checkpoint,
  type HookEvent,
  type SessionCheckpoint,
} from "./instrument.ts";
import {
  getScenarioBundle,
  scenarioTurns,
  assertDescriptionClean,
} from "./scenarios/context-load.ts";
import type { FloorOpts } from "./run-shape-floor.ts";

// Default to the vendor 3-hop scenario — still fully overridable via
// ADHERENCE_SCENARIO (same resolution mechanism as run-h3.ts), but this file's
// whole reason for existing is proving grant-access enforcement, so a bare
// invocation should not silently land on the refund scenario instead.
const SCENARIO_ID = process.env.ADHERENCE_SCENARIO ?? "context-load-vendor";
const { scenario: contextLoadScenario, seed: seedProject } = getScenarioBundle(SCENARIO_ID);

const JUDGE_MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? "gpt-5.1"; // referee — unchanged from H3
const RETRY_CAP = Number(process.env.ADHERENCE_RETRY_CAP ?? 3) || 3;
const CREDS = defaultCredsPath();
// The blocking retries + a Sonnet gate round-trip per enforced procedure lengthen
// the target turn; default generously (7 min/turn), same as H3.
const SUBJECT_TIMEOUT_MS = Number(process.env.ADHERENCE_SUBJECT_TIMEOUT_MS ?? 420_000);
// The gitignored .env whose PATH (never value) the REFEREE reads OPENAI_API_KEY
// from. Same file run-h3.ts loads from. The subject's plugin gate does NOT use
// this — it authenticates via the sandboxed Claude Max OAuth creds symlink.
const OPENAI_ENV_PATH =
  process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";

// ---- PLUGIN DoD-specific -----------------------------------------------
/** Absolute path to the procedure-adherence-plugin checkout under test. */
const PLUGIN = "/home/ubuntu/langwatch-workspace/procedure-adherence-plugin";
/**
 * The plugin's shipped Stop gate is CLAUDE-ONLY (owner constraint #784 — no
 * GPT in the shipped runtime; `hooks/lib.mjs`'s `isClaudeGate` fail-open
 * branch has no OpenAI path at all). Sonnet by default; env-overridable
 * (e.g. `claude-haiku-4-5` for a cost arm) — gate parity is subject-invariant.
 */
const GATE_MODEL = process.env.ADHERENCE_GATE_MODEL ?? "claude-sonnet-4-5";
/**
 * Subject on Haiku by default — far cheaper than the box default
 * (`claude -p` with no `--model`), and gate parity is subject-invariant. Fed
 * to the tee shim via ADHERENCE_SUBJECT_MODEL (teeShimSource,
 * tee-substrate.ts); run-h3.ts never sets this env var, but the shim it
 * shares has always supported it (the model-sweep arm exercises it).
 */
const SUBJECT_MODEL = process.env.ADHERENCE_SUBJECT_MODEL ?? "claude-haiku-4-5";
/**
 * Free-form label for the checkpoint / run-data / log lines ONLY — NEVER fed
 * to `AdherenceJudge`'s `strategy` field. `types.ts`'s `Strategy` is a closed
 * `"none"|"baseline"|"h1"|"h2"|"h3"` union with real attribution semantics
 * (`judge-core.ts:mapAttribution`); this run keeps `sandbox.strategy.name`
 * ("h3") there and in the OTEL resourceAttrs/emitJudgeVerdict `strategy` param
 * — the plugin's per-procedure ≡ judge gate is exactly that mechanism (just
 * chain-closure-scoped and Claude- rather than OpenAI-judged), and OTEL
 * correlation must stay in sync with what `buildSandbox` already baked into
 * `settings.json`'s `OTEL_RESOURCE_ATTRIBUTES` at construction time.
 */
const STRATEGY_LABEL = "plugin-dod";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Durable, git-tracked destination for DATA-FIRST retention (item 3). */
const RUN_DATA_ROOT = join(HERE, "run-data", "plugin-dod");

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

/**
 * Discard buildSandbox("h3", ...)'s EXPERIMENT-HARNESS hooks
 * (strategies/h3.ts + strategies/hooks-lib.mjs) and install the PLUGIN's OWN
 * shipped hooks (hooks/compile.sh + hooks/gate.sh -> hooks/lib.mjs) instead —
 * the actual artifact this file exists to prove. Everything ELSE buildSandbox
 * already set up (creds symlink, corpus symlink, CLAUDE.md framing,
 * permissions.allow, OTEL env, tee shim) stays; only settings.json's `hooks`
 * key is replaced.
 *
 * Env is baked into each command string (never relies on process-env
 * propagation into the hook subprocess), single-quote-escaped — mirrors the
 * `hookCommand()` convention in strategies/common.ts.
 */
function installPluginHooks(sandbox: Sandbox): void {
  const settingsPath = join(sandbox.configDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  const env =
    `CLAUDE_PLUGIN_ROOT='${PLUGIN}' CLAUDE_PROJECT_DIR='${sandbox.projectDir}' ` +
    `ADHERENCE_CORPUS_DIR='${CORPUS_DIR}' ADHERENCE_GATE_MODEL='${GATE_MODEL}' ` +
    `ADHERENCE_HOOK_LOG='${sandbox.hookLog}' ADHERENCE_RETRY_CAP='${RETRY_CAP}'`;
  settings.hooks = {
    UserPromptSubmit: [
      {
        matcher: "",
        hooks: [{ type: "command", command: `${env} bash '${PLUGIN}/hooks/compile.sh'`, timeout: 120 }],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [{ type: "command", command: `${env} bash '${PLUGIN}/hooks/gate.sh'`, timeout: 180 }],
      },
    ],
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

/**
 * DATA-FIRST retention (same discipline as the #784 salvage commits — "data
 * is gold"): copy the raw, EPHEMERAL (/tmp sandbox) artifacts into the
 * durable, git-tracked `run-data/plugin-dod/<runId>/`. Best-effort and
 * idempotent — safe to call more than once per run (a later call just
 * refreshes the copy, e.g. once the FINAL judged checkpoint has replaced the
 * earlier "running" stub). A salvage failure must never abort the run.
 */
function salvageRunData(sandbox: Sandbox): string {
  const dest = join(RUN_DATA_ROOT, sandbox.runId);
  try {
    mkdirSync(dest, { recursive: true });
    if (existsSync(sandbox.hookLog)) {
      cpSync(sandbox.hookLog, join(dest, "hook-events.jsonl"), { force: true });
    }
    const stateDir = join(sandbox.projectDir, ".procedure-adherence", "state");
    if (existsSync(stateDir)) {
      cpSync(stateDir, join(dest, "procedure-adherence-state"), { recursive: true, force: true });
    }
    const checkpointPath = join(sandbox.root, "checkpoint.json");
    if (existsSync(checkpointPath)) {
      cpSync(checkpointPath, join(dest, "checkpoint.json"), { force: true });
    }
    if (existsSync(sandbox.transcriptDir)) {
      cpSync(sandbox.transcriptDir, join(dest, "transcript"), { recursive: true, force: true });
    }
  } catch (e) {
    log(`  !! salvage to ${dest} FAILED (non-fatal, continuing): ${(e as Error).message}`);
  }
  return dest;
}

interface PluginLogSummary {
  compileEvents: HookEvent[];
  gateEvents: HookEvent[];
  decisions: string[];
  blockedOnGrantAccess: boolean;
  forcedCompletionAfterBlock: boolean;
}

/**
 * Parse the PLUGIN's OWN hook-log vocabulary directly. `summarizeHooks`/
 * `summarizeH3` (instrument.ts) are keyed on the EXPERIMENT HARNESS's mode
 * strings (`h1-compile`/`h3-verify`, from strategies/hooks-lib.mjs) — the
 * shipped plugin (hooks/lib.mjs, a port of that file) logs `mode:"compile"`/
 * `mode:"gate"` instead (see hooks/lib.mjs's own "Production hook
 * entrypoints" section), so those summarizers would silently read this log as
 * all-zero. This is the plugin-native equivalent, parsing exactly the fields
 * the DoD claim needs: `decision`, `blockedProcs`, `enforcedVia`, `gateModel`.
 */
function summarizePluginLog(events: HookEvent[]): PluginLogSummary {
  const compileEvents = events.filter((e) => e.mode === "compile");
  const gateEvents = events.filter((e) => e.mode === "gate");
  const decisions = gateEvents.map((e) => String(e.decision ?? ""));
  const blockedOnGrantAccess = gateEvents.some(
    (e) =>
      e.decision === "block" &&
      ((e.blockedProcs as string[] | undefined) ?? []).includes("grant-access"),
  );
  const forcedCompletionAfterBlock = decisions.includes("allow-complete-after-retry");
  return { compileEvents, gateEvents, decisions, blockedOnGrantAccess, forcedCompletionAfterBlock };
}

async function runFull(openaiKey: string | undefined): Promise<void> {
  const corpus = loadCorpus();
  const turns = scenarioTurns(contextLoadScenario);
  let actualJudgeModel = JUDGE_MODEL;

  // "h3" is the SANDBOX SCAFFOLD strategy only (creds symlink, corpus symlink,
  // permissions.allow, CLAUDE.md framing, OTEL wiring, tee shim) — its hooks
  // are discarded/overridden below by installPluginHooks. A distinct runId
  // keeps this run's /tmp sandbox and run-data/ folder unambiguous.
  const sandbox = buildSandbox("h3", {
    runId: `plugin-dod-${Date.now()}`,
    applicable: contextLoadScenario.applicable,
    retryCap: RETRY_CAP,
    judgeModel: JUDGE_MODEL,
    openaiEnvPath: OPENAI_ENV_PATH,
  });
  const seeded = seedProject(sandbox.projectDir);
  installPluginHooks(sandbox);
  log(`sandbox ............. ${sandbox.root}`);
  log(`  creds symlink realpath (outside repo): ${sandbox.credsRealpath}`);
  log(`  seeded project state: ${seeded.join(", ")}`);
  log(`  scaffold strategy ... h3 (buildSandbox internals only — creds/corpus symlink, permissions, OTEL, tee shim)`);
  log(`  INSTALLED hooks ..... PLUGIN (hooks/compile.sh + hooks/gate.sh -> hooks/lib.mjs) — h3's own hooks discarded`);
  log(`    CLAUDE_PLUGIN_ROOT=${PLUGIN}`);
  log(`    CLAUDE_PROJECT_DIR=${sandbox.projectDir}`);
  log(`    ADHERENCE_CORPUS_DIR=${CORPUS_DIR}`);
  log(`    ADHERENCE_GATE_MODEL=${GATE_MODEL} (Claude OAuth Max bucket — NOT OpenAI; owner constraint #784)`);
  log(`    ADHERENCE_HOOK_LOG=${sandbox.hookLog}`);
  log(`    ADHERENCE_RETRY_CAP=${RETRY_CAP}`);
  log(`  subject model ....... ${SUBJECT_MODEL}`);
  log(`  enforced applicable set (referee denominator): [${contextLoadScenario.applicable.join(", ")}]`);

  // Pre-write a running checkpoint so an abort still leaves a record on disk.
  checkpoint(join(sandbox.root, "checkpoint.json"), {
    scenarioId: contextLoadScenario.id,
    strategy: STRATEGY_LABEL,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    configDir: sandbox.configDir,
    workDir: sandbox.workDir,
  });

  const restoreEnv = applyChildEnv(sandbox);
  // L5: snapshot/set/restore ADHERENCE_SUBJECT_MODEL (applyChildEnv does not
  // manage it — see the top-of-file note on item 2).
  const priorSubjectModel = process.env.ADHERENCE_SUBJECT_MODEL;
  process.env.ADHERENCE_SUBJECT_MODEL = SUBJECT_MODEL;
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

    // Referee judge stays gpt-5.1 DIRECT — never the Anthropic path (asserted
    // in main()). Unaffected by the subject's plugin gate running on Sonnet.
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
      strategy: sandbox.strategy.name, // "h3" — see STRATEGY_LABEL note above
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

    log(`\n--- FULL scenario.run (PLUGIN DoD): ${turns.length} scripted turns, target buried last ---`);
    const result = await scenario.run({
      name: contextLoadScenario.name,
      description: contextLoadScenario.description,
      agents: [subject, scenario.userSimulatorAgent({ model: openai("gpt-5-mini") }), judge],
      script,
      setId: "spike-784-adherence",
      maxTurns: 30,
    });

    // DATA-FIRST retention (item 3): salvage the raw artifacts off /tmp and
    // onto the durable worktree BEFORE any further processing that could
    // itself throw (report synthesis, logging, telemetry) — "data is gold"
    // (#784 salvage commits b00cd02/e3eab3a).
    const salvageDest = salvageRunData(sandbox);

    const report = judge.lastReport;
    const substrate = readSubstrate(sandbox.workDir);
    const actions = extractActionLog(substrate);
    // Owner requirement: the resolved subject model is a LOGGED VARIABLE every run.
    const subjectModel = extractSubjectModel(substrate).join(",") || "unknown";
    // #784 delegation dimension (logged only): did the subject use the
    // Task/subagent tool during this run, vs doing the procedure work directly.
    const delegation = detectDelegation(actions);
    const acct = classifyRun(substrate);
    const hookEvents = readHookLog(sandbox.hookLog);
    const plugin = summarizePluginLog(hookEvents);

    const cp: SessionCheckpoint = {
      scenarioId: contextLoadScenario.id,
      strategy: STRATEGY_LABEL,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: report?.belowFloor ? "excluded" : "judged",
      configDir: sandbox.configDir,
      workDir: sandbox.workDir,
      turnCounts: acct,
      report,
      notes: [
        `subject model resolved: ${subjectModel} (requested: ${SUBJECT_MODEL})`,
        `judge model actually used: ${actualJudgeModel}`,
        `scenario.run success=${result.success}`,
        `delegated: ${delegation.delegated} (taskCalls=${delegation.taskCalls})`,
        `PLUGIN compile fires=${plugin.compileEvents.length} gate fires=${plugin.gateEvents.length}`,
        `PLUGIN gate decisions=[${plugin.decisions.join(", ")}]`,
        `PLUGIN gate blockedOnGrantAccess=${plugin.blockedOnGrantAccess} forcedCompletionAfterBlock=${plugin.forcedCompletionAfterBlock}`,
      ],
    };
    checkpoint(join(sandbox.root, "checkpoint.json"), cp);
    salvageRunData(sandbox); // refresh: capture the FINAL (judged) checkpoint too

    // LangWatch judge-verdict telemetry (owner req: scores + reasoning shipped to
    // LangWatch, ATTACHED to the run's traces via the SAME run.id/experiment/
    // strategy/scenario resource attrs otelWiring used). FAIL-OPEN + fire-and-forget:
    // no ik-lw- key ⇒ no-op; the emitter swallows any failure/timeout and we re-guard
    // here so it can NEVER fail or slow the run. The checkpoint above stays authoritative.
    try {
      const emit = await emitJudgeVerdict({
        resourceAttrs: sandbox.otelResourceAttrs,
        report,
        scenarioId: contextLoadScenario.id,
        strategy: sandbox.strategy.name, // OTEL correlation: keep in sync with sandbox.otelResourceAttrs (baked at buildSandbox time)
        judgeModel: actualJudgeModel,
        subjectModel,
        scenarioRunSuccess: result.success,
        status: cp.status,
      });
      // Log the emit result so EACH run's judge-scores+reasoning span is query-back-able
      // by traceId (owner DATA-FIRST: confirm judge spans landing, per run — get_trace <traceId>).
      log(
        `judge-verdict telemetry: emitted=${emit?.emitted} status=${emit?.status} rejectedSpans=${emit?.rejectedSpans} traceId=${emit?.traceId ?? "-"}`,
      );
    } catch {
      /* best-effort telemetry — never affect the run */
    }

    // ---- EVIDENCE ----
    log(`\n================ PLUGIN DoD — result ================`);
    log(`scenario ............ ${contextLoadScenario.id}`);
    log(`configDir ........... ${sandbox.configDir}`);
    log(`substrate turns ..... ${substrate.length}  (accounting: total=${acct.total} excluded=${acct.excluded} hardError=${acct.hardError})`);
    log(`subject tool actions  ${actions.length} (tool_use=${actions.filter((a) => a.kind === "tool_use").length}, tool_result=${actions.filter((a) => a.kind === "tool_result").length})`);
    log(`  actions: ${actions.slice(0, 24).map((a) => (a.kind === "tool_use" ? `${a.name}(${JSON.stringify(a.input).slice(0, 34)})` : "→result")).join("  ")}`);

    log(`\nPLUGIN compile (UserPromptSubmit -> hooks/compile.sh): fires=${plugin.compileEvents.length}`);
    for (const e of plugin.compileEvents) {
      log(
        `  retrieved=[${((e.retrieved as string[] | undefined) ?? []).join(", ")}] compiledIds=[${((e.compiledIds as string[] | undefined) ?? []).join(", ")}] haikuStatus=${e.haikuStatus} haikuOk=${e.haikuOk}`,
      );
    }

    log(`\nPLUGIN gate (Stop -> hooks/gate.sh, gateModel=${GATE_MODEL}): fires=${plugin.gateEvents.length}`);
    for (const e of plugin.gateEvents) {
      log(
        `  decision=${String(e.decision ?? "-").padEnd(28)} enforcedVia=${String(e.enforcedVia ?? "-").padEnd(12)} gateModel=${e.gateModel ?? "-"} blockedProcs=[${((e.blockedProcs as string[] | undefined) ?? []).join(", ")}] retry=${e.retry ?? "-"} priorBlocks=${e.priorBlocks ?? "-"}`,
      );
    }
    log(`  decision sequence ..................... [${plugin.decisions.join(", ")}]`);
    log(`  gate BLOCKED on grant-access ........... ${plugin.blockedOnGrantAccess}`);
    log(`  gate FORCED completion after the block . ${plugin.forcedCompletionAfterBlock}  (decision sequence reached allow-complete-after-retry)`);
    log(
      `  DoD claim (block on grant-access + forces the step) .. ${
        plugin.blockedOnGrantAccess && plugin.forcedCompletionAfterBlock
          ? "REPRODUCED this run"
          : "NOT reproduced this run — see decision sequence above"
      }`,
    );

    log(`\nsubject model ....... ${subjectModel}  (claude -p resolved — requested ${SUBJECT_MODEL})`);
    log(`referee judge model . ${actualJudgeModel}`);
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
      log(`  (caveat: 'surfaced'/'attribution' can undercount here — collectCompiledSheetIds() filters`);
      log(`   mode:"h1-compile", the HARNESS's own label; the plugin logs mode:"compile", so the sheet-`);
      log(`   surfaced union is empty this run. followed/adherenceRate are UNAFFECTED — action-log-only,`);
      log(`   judge-core.ts:scoreAdherence — attribution only matters when followed=false.)`);
    }

    // The independently-checkable, on-disk trace of grant-access's step 3
    // ("set an expiry on the role binding") actually landing.
    const auditLedgerPath = join(sandbox.projectDir, "state", "audit-ledger.jsonl");
    let auditLedgerEvidence = `(not found: ${auditLedgerPath})`;
    if (existsSync(auditLedgerPath)) {
      const ledgerLines = readFileSync(auditLedgerPath, "utf8").split("\n").filter(Boolean);
      const withExpiry = ledgerLines.filter((l) => l.includes("expires_at"));
      auditLedgerEvidence = withExpiry.length
        ? withExpiry.join("\n    ")
        : `(no "expires_at" field in any of ${ledgerLines.length} ledger entries — grant-access's step-3 expiry was NOT enacted on disk)`;
    }
    log(`\non-disk audit-ledger expires_at (grant-access's forced step) ...`);
    log(`    ${auditLedgerEvidence}`);

    log(`\nrun-data salvage ..... ${salvageDest}`);
    log(`checkpoint .......... ${join(sandbox.root, "checkpoint.json")}`);
    log(`scenario.run success  ${result.success}`);
  } catch (e) {
    // DATA-FIRST: salvage before anything else, even on abort.
    const salvageDest = salvageRunData(sandbox);
    const substrate = readSubstrate(sandbox.workDir);
    const acct = classifyRun(substrate);
    const hookEvents = readHookLog(sandbox.hookLog);
    const plugin = summarizePluginLog(hookEvents);
    checkpoint(join(sandbox.root, "checkpoint.json"), {
      scenarioId: contextLoadScenario.id,
      strategy: STRATEGY_LABEL,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "aborted",
      configDir: sandbox.configDir,
      workDir: sandbox.workDir,
      turnCounts: acct,
      error: (e as Error).message,
      notes: [
        "run aborted; checkpoint preserved (not measured)",
        `PLUGIN gate decisions=[${plugin.decisions.join(", ")}]`,
      ],
    });
    salvageRunData(sandbox); // refresh: capture the aborted checkpoint too
    log(`\n!! RUN ABORTED: ${(e as Error).message}`);
    log(`   substrate captured so far: ${substrate.length} turns; excluded=${acct.excluded} hardError=${acct.hardError}`);
    log(`   PLUGIN gate decisions before abort: [${plugin.decisions.join(", ")}]`);
    log(`   checkpoint preserved at ${join(sandbox.root, "checkpoint.json")} (status=aborted, NOT measured)`);
    log(`   run-data salvage .. ${salvageDest}`);
    process.exitCode = 3;
  } finally {
    if (priorSubjectModel === undefined) delete process.env.ADHERENCE_SUBJECT_MODEL;
    else process.env.ADHERENCE_SUBJECT_MODEL = priorSubjectModel;
    restoreEnv();
  }
}

async function main(): Promise<void> {
  const openaiKey = loadOpenAIKey();
  log("================ #784 PLUGIN DoD — live claude -p subject wired to the SHIPPED plugin hooks ================");
  log(`strategy label ...... ${STRATEGY_LABEL}  (sandbox scaffold: h3; installed hooks: PLUGIN)`);
  log(`scenario ............ ${contextLoadScenario.id}`);
  log(`referee judge model . ${JUDGE_MODEL}`);
  log(`subject's gate model  ${GATE_MODEL}  (the plugin's shipped Stop gate — Claude Max OAuth, NOT OpenAI)`);
  log(`subject model ........ ${SUBJECT_MODEL}`);

  // Referee assertion (unchanged from H3): the REFEREE must stay non-Anthropic.
  // Does NOT constrain the subject's own gate, which is deliberately Claude
  // (Sonnet) in this file — that is the thing under test.
  if (/^claude/i.test(JUDGE_MODEL)) {
    throw new Error(`referee judge must be OpenAI gpt-5.1, never the Anthropic path; got JUDGE_MODEL=${JUDGE_MODEL}`);
  }
  if (!openaiKey) {
    throw new Error(
      "No OPENAI_API_KEY available (checked env + scenario .env); the gpt-5.1 REFEREE cannot run. (The subject's plugin gate does not need this key — it authenticates via the sandboxed Claude Max OAuth creds symlink, same as the subject session itself.)",
    );
  }

  // Guard the description before it reaches the user-sim system prompt (#705).
  const allIds = [...loadCorpus().keys()];
  assertDescriptionClean(contextLoadScenario.description, allIds);
  log(`description leak-check PASS (procedure-agnostic; ${allIds.length} ids checked)`);
  log(`subject per-turn timeout: ${SUBJECT_TIMEOUT_MS}ms; retry cap: ${RETRY_CAP}`);
  log(`plugin corpus dir .... ${CORPUS_DIR}`);
  log(`plugin root .......... ${PLUGIN}`);

  await runFull(openaiKey);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
