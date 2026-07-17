/**
 * growth-loop — the MINIMAL live growth-loop demonstration for #784 (AC9 / DoD
 * prop 3), BASELINE strategy only, judged on OpenAI gpt-5.1.
 *
 * Closes the self-hardening loop with the SMALLEST session count (2 baseline
 * `claude -p` sessions):
 *
 *   PHASE adopt   — the subject is given a task with NO covering procedure in the
 *                   corpus and the standing rule "if none covers it, FIRST author
 *                   one via the author-procedure meta-procedure, then do it". The
 *                   subject's OWN `Write` tool_use creates a new `active`
 *                   PROCEDURE.md in a WRITABLE in-cwd corpus copy -> the corpus
 *                   GROWS +1 (168 -> 169). Evidence: the Write action + the new
 *                   procedure id/path/status + the on-disk corpus-count diff.
 *
 *   PHASE adhere  — a FRESH sandbox (new `claude -p`, NO --resume) whose corpus is
 *                   the GROWN 169 copied from adopt. The subject gets the SAME
 *                   task class with the new procedure's rule text ABSENT from the
 *                   prompt. The baseline retrieval hook surfaces the new procedure
 *                   and the subject FOLLOWS it UNPROMPTED; the gpt-5.1 judge scores
 *                   followed=true. Evidence: judge verdict + prompt-grep-clean +
 *                   the live baseline hook's `retrieved` naming the new id.
 *
 * ANTI-DORMANCY: each phase runs ONE `claude -p` session SYNCHRONOUSLY in the
 * FOREGROUND (spawnSync) with a hard timeout; nothing is backgrounded, no
 * sub-agents. A handoff JSON is written after adopt so adhere is a separate
 * foreground invocation (each session fits a bounded wall-clock budget) and each
 * session is checkpointed immediately.
 *
 * NO scenario-core edits. BASELINE only (no Haiku hooks -> no extra bucket draw;
 * the only Claude Max bucket use is the 2 subject sessions themselves). The judge
 * is gpt-5.1 (OpenAI) — never the Anthropic path.
 *
 * Run (from javascript/examples/vitest/):
 *   ADHERENCE_JUDGE_MODEL=gpt-5.1 tsx spike-784-adherence/growth-loop.ts --phase=adopt
 *   ADHERENCE_JUDGE_MODEL=gpt-5.1 tsx spike-784-adherence/growth-loop.ts --phase=adhere
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSandbox } from "./sandbox.ts";
import {
  loadCorpus as loadCorpusIndex,
  parseFrontmatter,
  CORPUS_DIR,
} from "./corpus-loader.ts";
// hooks-lib is the SAME BM25 retriever the live baseline hook runs — reuse it for
// the 0-bucket offline retrieval gate between sessions.
// @ts-expect-error — .mjs sibling, node-builtins only, typed as any under tsx.
import { loadCorpus as loadCorpusEntries, retrieve } from "./strategies/hooks-lib.mjs";
import { materializeBaseline } from "./strategies/baseline.ts";
import type { MaterializeCtx } from "./strategies/common.ts";
import { ensureTranscriptDir, writeTeeShim, readSubstrate, TRANSCRIPT_SUBDIR } from "./tee-substrate.ts";
import { extractActionLog } from "./normalize.ts";
import { scoreAdherence, callOpenAI } from "./judge-core.ts";
import { classifyRun, readHookLog, summarizeHooks, checkpoint } from "./instrument.ts";
import type { SessionCheckpoint } from "./instrument.ts";
import type { ActionRecord, CorpusIndex } from "./types.ts";
import type { FloorOpts } from "./run-shape-floor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS_LIB_SRC = join(HERE, "strategies", "hooks-lib.mjs");
const SANDBOX_ROOT = process.env.ADHERENCE_SANDBOX_ROOT ?? join(tmpdir(), "adherence-784-sandboxes");
const SUBJECT_TIMEOUT_MS = Number(process.env.ADHERENCE_SUBJECT_TIMEOUT_MS ?? 480_000);
const JUDGE_MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? "gpt-5.1";
const HANDOFF =
  process.env.ADHERENCE_GROWTH_STATE ??
  "/tmp/claude-1000/-home-ubuntu-langwatch-workspace-scenario-784-adherence/da246f5b-f4d2-4942-b6a6-f36ceb6e310b/scratchpad/growth-handoff.json";

function log(...a: unknown[]): void {
  console.log(...a);
}

// ---------------------------------------------------------------------------
// The two prompts (task class = register a customer webhook callback subscription
// — a family provably ABSENT from the 168-proc corpus; verified by BM25 probe).
// ---------------------------------------------------------------------------

/**
 * ADOPT: task with no covering procedure. The generic "author-first-if-uncovered"
 * rule lives in the sandbox CLAUDE.md; the prompt states the task + the files and
 * (generically) applies the rule. It does NOT dictate the new procedure's steps.
 */
const ADOPT_PROMPT =
  "A customer wants their own system to receive automatic callbacks from us whenever certain account events happen (a webhook subscription). Their pending setup request is on file at `state/requests/setup-3310.json` (it has the callback URL and the event types they selected), and the current subscriptions live in `state/webhooks.jsonl`. We do not have a written procedure covering this kind of request yet, so first follow `corpus/author-procedure/PROCEDURE.md` to write and adopt a new active procedure for it, then carry the request out by following that new procedure.";

/**
 * FRESH-ADHERE: SAME task class, a DIFFERENT request. The new procedure's NAME and
 * its MECHANICAL steps (append an active subscription to the registry, set status)
 * are deliberately ABSENT — only the task outcome is stated. The retrieved
 * procedure (surfaced by the baseline hook) must supply the "how".
 */
const ADHERE_PROMPT =
  "A customer wants their own system to receive our automatic callbacks whenever certain account events happen. Their setup request is at `state/requests/setup-4420.json` (it has the callback URL and the event types they selected), and our existing callback records live in `state/webhooks.jsonl`. Get their integration set up so their system starts receiving these events.";

/**
 * Tokens that would mean the ADHERE prompt RESTATED the procedure's NAME or its
 * MECHANICAL steps (how: create a subscription record in the store, append it, set
 * status active, mark the request fulfilled). Task/domain words the request
 * unavoidably shares (callback, event, request, the webhooks.jsonl filename) are
 * NOT rule-restatements and are intentionally excluded.
 */
const RULE_MECHANIC_TOKENS = ["create-subscription", "subscription", "append", "registry", "status: active", "fulfilled", "subscription_id"];

const ADOPT_CLAUDE_MD = `# Operating under a procedure corpus (with authority to adopt new procedures)

You are an operations assistant working through back-office requests in a live session.

Your team keeps written operating **procedures** as \`corpus/<id>/PROCEDURE.md\` files in
your current working directory. These procedures are BINDING: when a request is covered by an
existing procedure, follow that procedure's numbered steps exactly, carrying out EACH step as a
concrete tool action (read the state, write the file, update the record — do not merely
describe it).

If NO existing procedure covers the request, you MUST FIRST create one, then do the task:
  1. Follow the meta-procedure at \`corpus/author-procedure/PROCEDURE.md\`. Create a new file
     \`corpus/<new-id>/PROCEDURE.md\` with a neutral verb-object id, frontmatter (\`id\`,
     \`kind: procedure\`, \`keywords\`, \`links\`, \`status\`) and a body of concrete numbered steps,
     and set its \`status\` to \`active\` so future operators follow it automatically.
  2. THEN carry out the request by following the procedure you just adopted, as concrete tool
     actions.

Retrieval assistance may be injected into your context before each request to help you find
applicable procedures in the corpus. Work ONLY inside the current working directory. Keep going
until the request is fully carried out as concrete actions.
`;

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

function which(bin: string): string {
  const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  const p = r.stdout.trim().split("\n").pop() ?? "";
  if (!p) throw new Error(`cannot resolve ${bin} on PATH`);
  return p;
}

/** Load OPENAI_API_KEY from the gitignored scenario .env (never committed). */
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

/** Count / list corpus procedure dirs (a dir with a PROCEDURE.md). */
function corpusIds(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "PROCEDURE.md")))
    .map((d) => d.name)
    .sort();
}

interface SessionResult {
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  stderrHead: string;
}

/**
 * Run ONE `claude -p` session synchronously in the foreground through the tee
 * shim, with a hard timeout. No global env mutation — the child env is passed
 * directly. Asserts the config dir is the sandbox's, never the real ~/.claude.
 */
function runClaudeSession(o: {
  shim: string;
  cwd: string;
  configDir: string;
  transcriptDir: string;
  prompt: string;
  timeoutMs: number;
  label: string;
}): SessionResult {
  const realConfig = realpathSync(join(homedir(), ".claude"));
  if (realpathSync(o.configDir) === realConfig) {
    throw new Error(`configDir resolved to the REAL ~/.claude — isolation broken`);
  }
  log(`\n--- [${o.label}] claude -p session (timeout ${Math.round(o.timeoutMs / 1000)}s) ---`);
  log(`    cwd=${o.cwd}`);
  const started = Date.now();
  const run = spawnSync(
    "bash",
    [o.shim, "-p", "--output-format", "stream-json", "--verbose", o.prompt],
    {
      cwd: o.cwd,
      encoding: "utf8",
      timeout: o.timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CONFIG_DIR: o.configDir, ADHERENCE_TRANSCRIPT_DIR: o.transcriptDir },
    },
  );
  const timedOut = run.signal === "SIGTERM" || (run.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  log(`    exit=${run.status} signal=${run.signal ?? "-"} timedOut=${timedOut} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
  if (run.stderr?.trim()) log(`    stderr(head): ${run.stderr.slice(0, 300)}`);
  return { status: run.status, signal: run.signal, timedOut, stderrHead: (run.stderr ?? "").slice(0, 400) };
}

/** The subject's OWN authoring writes: Write/Edit tool_use touching corpus/<id>/PROCEDURE.md. */
function findAuthoringWrites(actions: ActionRecord[]): Array<{ name: string; filePath: string; snippet: string }> {
  const out: Array<{ name: string; filePath: string; snippet: string }> = [];
  for (const a of actions) {
    if (a.kind !== "tool_use") continue;
    if (!/^(Write|Edit|MultiEdit)$/.test(a.name ?? "")) continue;
    const inputText = JSON.stringify(a.input ?? "");
    const m = /(corpus\/[A-Za-z0-9._-]+\/PROCEDURE\.md)/.exec(inputText);
    if (!m) continue;
    const fp =
      (a.input as { file_path?: string } | undefined)?.file_path ?? m[1];
    out.push({ name: a.name ?? "?", filePath: fp, snippet: inputText.slice(0, 240) });
  }
  return out;
}

/** Seed the ADOPT request (task the adopt session must handle). */
function seedAdopt(projectDir: string): void {
  const reqDir = join(projectDir, "state", "requests");
  mkdirSync(reqDir, { recursive: true });
  writeFileSync(
    join(reqDir, "setup-3310.json"),
    JSON.stringify(
      {
        request_id: "setup-3310",
        customer_id: "c_5521",
        callback_url: "https://hooks.acme-corp.example/ingest",
        event_types: ["account.created", "account.updated", "account.closed"],
        status: "pending",
        received_at: "2026-07-10T10:00:00Z",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(projectDir, "state", "webhooks.jsonl"),
    JSON.stringify({ subscription_id: "wh_1001", customer_id: "c_4400", callback_url: "https://old.example/hook", event_types: ["account.created"], status: "active" }) + "\n",
  );
}

/** Seed the FRESH-ADHERE request (SAME class, different customer/URL/events). */
function seedAdhere(projectDir: string): void {
  const reqDir = join(projectDir, "state", "requests");
  mkdirSync(reqDir, { recursive: true });
  writeFileSync(
    join(reqDir, "setup-4420.json"),
    JSON.stringify(
      {
        request_id: "setup-4420",
        customer_id: "c_7788",
        callback_url: "https://events.globex.example/webhook",
        event_types: ["account.updated", "account.closed"],
        status: "pending",
        received_at: "2026-07-11T09:00:00Z",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(projectDir, "state", "webhooks.jsonl"),
    JSON.stringify({ subscription_id: "wh_1001", customer_id: "c_4400", callback_url: "https://old.example/hook", event_types: ["account.created"], status: "active" }) + "\n",
  );
}

// ---------------------------------------------------------------------------
// PHASE adopt.
// ---------------------------------------------------------------------------

interface AdoptState {
  ok: boolean;
  reason?: string;
  newId?: string;
  newProcPath?: string;
  newProcStatus?: string;
  newProcBody?: string;
  corpusBefore: number;
  corpusAfter: number;
  grownCorpusDir?: string;
  authoringWrites: Array<{ name: string; filePath: string; snippet: string }>;
  baselineRetrieved: string[];
  substrateTurns: number;
  toolUse: number;
  toolResult: number;
  hardError: boolean;
  throttle: boolean;
  timedOut: boolean;
  retrievalGate?: { newIdRank: number; top: Array<{ id: string; score: number }> };
  adoptRoot: string;
}

async function phaseAdopt(): Promise<AdoptState> {
  const ts = Date.now();
  const runId = `adopt-${ts}`;
  const root = join(SANDBOX_ROOT, runId);
  rmSync(root, { recursive: true, force: true });

  const configDir = join(root, ".claude");
  const projectDir = join(root, "project");
  const adherenceDir = join(configDir, "adherence");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(adherenceDir, { recursive: true });
  const transcriptDir = ensureTranscriptDir(root);

  // L1: symlink real creds (never copy a secret).
  symlinkSync(realpathSync(join(homedir(), ".claude", ".credentials.json")), join(configDir, ".credentials.json"));

  // WRITABLE corpus copy IN the cwd — the subject authors into it and the +1 diff
  // is observed here on disk. (Deliberate deviation from the measurement sandbox's
  // clean-cwd posture: the growth ADOPT session's whole point is the subject
  // GROWING the corpus, so the corpus must be writable and reachable by the
  // meta-procedure's cwd-relative `corpus/<id>/PROCEDURE.md` path.)
  const corpusInCwd = join(projectDir, "corpus");
  cpSync(CORPUS_DIR, corpusInCwd, { recursive: true });
  const corpusBefore = corpusIds(corpusInCwd).length;

  writeFileSync(join(configDir, "CLAUDE.md"), ADOPT_CLAUDE_MD, "utf8");

  // Baseline hook (retrieval-only; NO Haiku), retrieving from the in-cwd corpus.
  const hookLibPath = join(adherenceDir, "hooks-lib.mjs");
  copyFileSync(HOOKS_LIB_SRC, hookLibPath);
  const hookLog = join(adherenceDir, "hook-events.jsonl");
  const ctx: MaterializeCtx = {
    hookLibPath,
    corpusDir: corpusInCwd,
    hookLog,
    sheetFile: join(adherenceDir, "last-sheet.txt"),
    retrievalK: 8,
    haikuModel: "claude-haiku-4-5",
    nodeBin: which("node"),
  };
  const materialized = materializeBaseline(ctx);
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({ permissions: { allow: ["Edit", "Write"] }, hooks: materialized.hooks }, null, 2),
    "utf8",
  );

  const shimPath = join(root, "claude-shim.sh");
  writeTeeShim(shimPath, which("claude"));
  chmodSync(shimPath, 0o755);
  seedAdopt(projectDir);

  log(`================ GROWTH LOOP — PHASE 1: ADOPT (baseline) ================`);
  log(`sandbox ............. ${root}`);
  log(`corpus (writable) ... ${corpusInCwd}  (before=${corpusBefore} procedures)`);
  log(`judge (later) ....... ${JUDGE_MODEL} (OpenAI; adopt itself is scored deterministically on disk)`);

  // Pre-write a running checkpoint so an abort still leaves a record.
  checkpoint(join(root, "checkpoint.json"), {
    scenarioId: "growth-adopt", strategy: "baseline",
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "running", configDir, workDir: root,
  });

  const res = runClaudeSession({
    shim: shimPath, cwd: projectDir, configDir, transcriptDir,
    prompt: ADOPT_PROMPT, timeoutMs: SUBJECT_TIMEOUT_MS, label: "adopt",
  });

  const turns = readSubstrate(root);
  const actions = extractActionLog(turns);
  const acct = classifyRun(turns);
  const hooks = summarizeHooks(readHookLog(hookLog));
  const baselineEvent = hooks.events.find((e) => e.mode === "baseline");
  const baselineRetrieved = (baselineEvent?.retrieved as string[]) ?? [];

  const idsAfter = corpusIds(corpusInCwd);
  const before = new Set(corpusIds(CORPUS_DIR));
  const newIds = idsAfter.filter((id) => !before.has(id));
  const authoringWrites = findAuthoringWrites(actions);

  const toolUse = actions.filter((a) => a.kind === "tool_use").length;
  const toolResult = actions.filter((a) => a.kind === "tool_result").length;

  log(`\nsubstrate ........... ${turns.length} turns (tool_use=${toolUse} tool_result=${toolResult})`);
  log(`baseline retrieved .. [${baselineRetrieved.join(", ")}]`);
  log(`corpus after ........ ${idsAfter.length} procedures  (new: ${newIds.join(", ") || "NONE"})`);
  log(`authoring writes .... ${authoringWrites.length}`);
  for (const w of authoringWrites) log(`  - ${w.name} ${w.filePath}`);

  const state: AdoptState = {
    ok: false, corpusBefore, corpusAfter: idsAfter.length, authoringWrites,
    baselineRetrieved, substrateTurns: turns.length, toolUse, toolResult,
    hardError: acct.hardError, throttle: acct.reasons.some((r) => r.kind === "throttle"),
    timedOut: res.timedOut, adoptRoot: root,
  };

  if (res.timedOut) state.reason = "adopt session TIMED OUT (SIGTERM)";
  else if (acct.hardError) state.reason = `adopt session hard-errored (${acct.reasons.map((r) => r.kind).join(",")})`;

  // Resolve the newly-authored procedure (prefer an ACTIVE new proc).
  let chosen: { id: string; path: string; status: string; body: string } | undefined;
  for (const id of newIds) {
    const p = join(corpusInCwd, id, "PROCEDURE.md");
    if (!existsSync(p)) continue;
    try {
      const { fm, body } = parseFrontmatter(readFileSync(p, "utf8"));
      const cand = { id, path: `corpus/${id}/PROCEDURE.md`, status: fm.status, body };
      if (fm.status === "active") { chosen = cand; break; }
      if (!chosen) chosen = cand; // fall back to a non-active new proc if that is all there is
    } catch {
      /* unparseable — skip */
    }
  }

  if (chosen) {
    state.newId = chosen.id;
    state.newProcPath = chosen.path;
    state.newProcStatus = chosen.status;
    state.newProcBody = chosen.body;
    log(`\nnew procedure ....... ${chosen.id}  status=${chosen.status}  (${chosen.path})`);
  }

  // Success = subject's OWN Write created a NEW active PROCEDURE.md AND corpus +1.
  const wroteActive = !!chosen && chosen.status === "active";
  const ownWriteOfNew =
    !!chosen && authoringWrites.some((w) => w.filePath.includes(`corpus/${chosen!.id}/PROCEDURE.md`));
  const grewByOne = idsAfter.length === corpusBefore + 1;

  state.ok = wroteActive && ownWriteOfNew && (grewByOne || newIds.length === 1) && !acct.hardError && !res.timedOut;
  if (!state.ok && !state.reason) {
    state.reason =
      !chosen ? "no new PROCEDURE.md appeared in the corpus" :
      !wroteActive ? `new procedure ${chosen.id} status is '${chosen.status}', not 'active'` :
      !ownWriteOfNew ? `no subject Write/Edit tool_use targeting corpus/${chosen.id}/PROCEDURE.md in the substrate` :
      `corpus did not grow by exactly +1 (before=${corpusBefore}, after=${idsAfter.length})`;
  }

  // 0-bucket retrieval gate: does the grown corpus surface the new id for the
  // ADHERE prompt? (Guards against spending the adhere session on an unretrievable
  // procedure.) Also snapshot the grown corpus for phase 2.
  if (state.ok && state.newId) {
    const grownCorpusDir = join(SANDBOX_ROOT, `grown-corpus-${ts}`);
    rmSync(grownCorpusDir, { recursive: true, force: true });
    cpSync(corpusInCwd, grownCorpusDir, { recursive: true });
    state.grownCorpusDir = grownCorpusDir;

    const grownEntries = loadCorpusEntries(grownCorpusDir);
    const hits = retrieve(ADHERE_PROMPT, grownEntries, 8) as Array<{ id: string; score: number }>;
    const rank = hits.findIndex((h) => h.id === state.newId);
    state.retrievalGate = { newIdRank: rank === -1 ? -1 : rank + 1, top: hits.map((h) => ({ id: h.id, score: Number(h.score.toFixed(3)) })) };
    log(`\nretrieval gate ...... new id '${state.newId}' rank for the ADHERE prompt over the grown ${grownEntries.length}-corpus: ${state.retrievalGate.newIdRank === -1 ? "NOT in top-8" : "#" + state.retrievalGate.newIdRank}`);
    log(`  top-8: ${state.retrievalGate.top.map((h) => `${h.id}(${h.score})`).join(", ")}`);
  }

  checkpoint(join(root, "checkpoint.json"), {
    scenarioId: "growth-adopt", strategy: "baseline",
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: state.ok ? "judged" : "aborted",
    configDir, workDir: root, turnCounts: acct,
    notes: [
      `adopt ok=${state.ok}${state.reason ? " reason=" + state.reason : ""}`,
      `corpus ${corpusBefore} -> ${idsAfter.length}`,
      state.newId ? `new=${state.newId} status=${state.newProcStatus}` : "new=NONE",
    ],
  });

  writeFileSync(HANDOFF, JSON.stringify(state, null, 2), "utf8");
  log(`\nhandoff written ..... ${HANDOFF}`);
  log(`ADOPT verdict ....... ${state.ok ? "SUCCESS (corpus grew +1 via the subject's own Write of an active procedure)" : "PARTIAL — " + state.reason}`);
  return state;
}

// ---------------------------------------------------------------------------
// PHASE adhere.
// ---------------------------------------------------------------------------

function promptGrepClean(prompt: string, newId: string, body: string | undefined): {
  clean: boolean;
  idPresent: boolean;
  mechanicHits: string[];
  steps: string[];
} {
  const lower = prompt.toLowerCase();
  const idPresent = lower.includes(newId.toLowerCase());
  const mechanicHits = RULE_MECHANIC_TOKENS.filter((t) => lower.includes(t));
  const steps = (body ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s/.test(l));
  return { clean: !idPresent && mechanicHits.length === 0, idPresent, mechanicHits, steps };
}

async function phaseAdhere(): Promise<void> {
  const openaiKey = loadOpenAIKey();
  if (!openaiKey) throw new Error("no OPENAI_API_KEY (needed for the gpt-5.1 judge)");

  if (!existsSync(HANDOFF)) throw new Error(`no adopt handoff at ${HANDOFF} — run --phase=adopt first`);
  const adopt = JSON.parse(readFileSync(HANDOFF, "utf8")) as AdoptState;
  if (!adopt.ok || !adopt.newId || !adopt.grownCorpusDir) {
    log(`================ GROWTH LOOP — PHASE 2: ADHERE — SKIPPED ================`);
    log(`adopt did not succeed (reason: ${adopt.reason ?? "unknown"}) — nothing to adhere to. Loop is PARTIAL at step 1.`);
    return;
  }
  const newId = adopt.newId;

  log(`================ GROWTH LOOP — PHASE 2: FRESH-ADHERE (baseline) ================`);
  log(`new procedure ....... ${newId} (${adopt.newProcPath})  status=${adopt.newProcStatus}`);
  log(`grown corpus ........ ${adopt.grownCorpusDir} (${loadCorpusEntries(adopt.grownCorpusDir).length} procedures)`);
  log(`judge model ......... ${JUDGE_MODEL} (OpenAI — never the Anthropic path)`);

  // Preflight: prove the gpt-5.1 judge answers BEFORE spending the subject session.
  log(`\n[preflight] pinging ${JUDGE_MODEL} ...`);
  const ping = await callOpenAI(
    'Reply with strict JSON only.',
    'Return exactly {"ok":true}.',
    JUDGE_MODEL,
    openaiKey,
    { logger: (m) => log(`   ${m}`) },
  );
  log(`[preflight] judge reachable; reply head: ${ping.slice(0, 60).replace(/\n/g, " ")}`);

  // Prompt-grep-clean: the new procedure's NAME + MECHANICAL steps are ABSENT.
  const grep = promptGrepClean(ADHERE_PROMPT, newId, adopt.newProcBody);
  log(`\nprompt-grep clean ... idPresent=${grep.idPresent} mechanicHits=[${grep.mechanicHits.join(", ")}] => ${grep.clean ? "CLEAN (rule text absent)" : "NOT CLEAN"}`);
  log(`  ADHERE prompt: ${ADHERE_PROMPT}`);
  log(`  authored procedure steps (must NOT be restated in the prompt):`);
  for (const s of grep.steps) log(`    ${s}`);

  // FRESH sandbox (new claude -p, NO --resume) over the GROWN corpus — standard
  // measurement posture: clean cwd + the new procedure delivered ONLY via baseline
  // retrieval injection (its file is NOT in cwd).
  const sandbox = buildSandbox("baseline", { corpusDir: adopt.grownCorpusDir, runId: `adhere-${Date.now()}` });
  seedAdhere(sandbox.projectDir);
  log(`\nsandbox ............. ${sandbox.root}`);
  log(`  creds symlink realpath (outside repo): ${sandbox.credsRealpath}`);

  checkpoint(join(sandbox.root, "checkpoint.json"), {
    scenarioId: "growth-adhere", strategy: "baseline",
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "running", configDir: sandbox.configDir, workDir: sandbox.workDir,
  });

  const res = runClaudeSession({
    shim: sandbox.shimPath, cwd: sandbox.projectDir, configDir: sandbox.configDir,
    transcriptDir: join(sandbox.root, TRANSCRIPT_SUBDIR), prompt: ADHERE_PROMPT,
    timeoutMs: SUBJECT_TIMEOUT_MS, label: "adhere",
  });

  const turns = readSubstrate(sandbox.workDir);
  const actions = extractActionLog(turns);
  const acct = classifyRun(turns);
  const hooks = summarizeHooks(readHookLog(sandbox.hookLog));
  const baselineEvent = hooks.events.find((e) => e.mode === "baseline");
  const liveRetrieved = (baselineEvent?.retrieved as string[]) ?? [];
  const surfacedLive = liveRetrieved.includes(newId);

  const toolUse = actions.filter((a) => a.kind === "tool_use").length;
  const toolResult = actions.filter((a) => a.kind === "tool_result").length;
  log(`\nsubstrate ........... ${turns.length} turns (tool_use=${toolUse} tool_result=${toolResult}) excluded=${acct.excluded} hardError=${acct.hardError}`);
  log(`live retrieval ...... baseline retrieved=[${liveRetrieved.join(", ")}] => new id surfaced this run: ${surfacedLive}`);
  log(`  subject actions: ${actions.slice(0, 24).map((a) => (a.kind === "tool_use" ? `${a.name}(${JSON.stringify(a.input).slice(0, 44)})` : "->result")).join("  ")}`);

  // Judge on gpt-5.1 ONLY (explicit llm -> callOpenAI; never Anthropic).
  const grownIndex: CorpusIndex = loadCorpusIndex(adopt.grownCorpusDir);
  const floor: FloorOpts = { id: "growth-adhere", minTurns: 5, requireHumanTurn: true, requireToolUse: true, requireActionEvidence: true };
  let report;
  try {
    report = await scoreAdherence({
      turns, applicable: [newId], corpus: grownIndex, chains: [], strategy: "baseline",
      model: JUDGE_MODEL, openaiApiKey: openaiKey, floor,
      llm: (s, u, _m) => callOpenAI(s, u, JUDGE_MODEL, openaiKey, { logger: (m) => log(`   ${m}`) }),
      logger: (m) => log(`   ${m}`),
    });
  } catch (e) {
    log(`\n!! judge call failed: ${(e as Error).message}`);
    report = undefined;
  }

  const verdict = report?.perProcedure.find((p) => p.id === newId);
  const followed = verdict?.followed === true && !report?.belowFloor;

  log(`\n================ FRESH-ADHERE — verdict ================`);
  if (report?.belowFloor) {
    log(`judge ............... EXCLUDED below run-shape floor (degenerate/aborted) — adherence not demonstrated`);
  } else if (!verdict) {
    log(`judge ............... no verdict (judge failed or run aborted)`);
  } else {
    log(`followed=${verdict.followed}  attribution=${verdict.attribution}  surfaced=${verdict.surfaced}`);
    log(`reasoning: ${verdict.reasoning}`);
  }

  const closed = followed && grep.clean && surfacedLive;
  log(`\nFRESH-ADHERE verdict  ${followed ? "SUCCESS (subject FOLLOWED the newly-adopted procedure UNPROMPTED)" : "NOT followed"}`);
  log(`GROWTH LOOP .......... ${closed ? "CLOSED" : "PARTIAL"} (step1 adopt=SUCCESS, step2 adhere=${followed ? "SUCCESS" : "not-followed"}, prompt-clean=${grep.clean}, surfaced-live=${surfacedLive})`);

  checkpoint(join(sandbox.root, "checkpoint.json"), {
    scenarioId: "growth-adhere", strategy: "baseline",
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: report?.belowFloor ? "excluded" : "judged",
    configDir: sandbox.configDir, workDir: sandbox.workDir, turnCounts: acct, report,
    notes: [
      `adhere followed=${followed} attribution=${verdict?.attribution ?? "-"}`,
      `promptGrepClean=${grep.clean} surfacedLive=${surfacedLive}`,
      `loop=${closed ? "CLOSED" : "PARTIAL"}`,
      `judge model=${JUDGE_MODEL}`,
    ],
  });

  // Persist the full result for FINDINGS (survives sandbox cleanup).
  const result = {
    loop: closed ? "CLOSED" : "PARTIAL",
    adopt: {
      newId, newProcPath: adopt.newProcPath, newProcStatus: adopt.newProcStatus,
      corpusBefore: adopt.corpusBefore, corpusAfter: adopt.corpusAfter,
      authoringWrites: adopt.authoringWrites, baselineRetrieved: adopt.baselineRetrieved,
      retrievalGate: adopt.retrievalGate, newProcBody: adopt.newProcBody,
    },
    adhere: {
      followed, attribution: verdict?.attribution, reasoning: verdict?.reasoning,
      belowFloor: report?.belowFloor ?? false, judgeModel: JUDGE_MODEL,
      promptGrepClean: grep.clean, grep, surfacedLive, liveRetrieved,
      substrateTurns: turns.length, toolUse, toolResult,
      actions: actions.slice(0, 40).map((a) => (a.kind === "tool_use" ? { k: "tool_use", name: a.name, input: JSON.stringify(a.input).slice(0, 200) } : { k: "tool_result", err: a.isError })),
      adherePrompt: ADHERE_PROMPT,
    },
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(HANDOFF.replace(/\.json$/, "-result.json"), JSON.stringify(result, null, 2), "utf8");
  log(`\nresult written ...... ${HANDOFF.replace(/\.json$/, "-result.json")}`);
}

// ---------------------------------------------------------------------------

/** 0-bucket preflight: prove imports/syntax + the gpt-5.1 judge + retrieval libs. */
async function dryCheck(): Promise<void> {
  log("================ GROWTH LOOP — DRY CHECK (0 subject sessions) ================");
  const key = loadOpenAIKey();
  log(`openai key .......... ${key ? "loaded (" + key.length + " chars)" : "MISSING"}`);
  const committed = loadCorpusIndex(CORPUS_DIR);
  log(`corpus index ........ ${committed.size} procedures (author-procedure present: ${committed.has("author-procedure")})`);
  const entries = loadCorpusEntries(CORPUS_DIR);
  const hits = retrieve(ADOPT_PROMPT, entries, 5) as Array<{ id: string; score: number }>;
  log(`retrieve() works .... top-5 for ADOPT prompt: ${hits.map((h) => h.id).join(", ")}`);
  if (key) {
    const ping = await callOpenAI('Reply with strict JSON only.', 'Return exactly {"ok":true}.', JUDGE_MODEL, key, { logger: (m) => log(`   ${m}`) });
    log(`${JUDGE_MODEL} ping ...... ${ping.slice(0, 60).replace(/\n/g, " ")}`);
  }
  log(`which(claude) ....... ${which("claude")}`);
  log(`which(node) ......... ${which("node")}`);
  log("DRY CHECK OK — imports, judge, retrieval, binaries all resolve.");
}

async function main(): Promise<void> {
  const phaseArg = process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? process.env.PHASE ?? "adopt";
  loadOpenAIKey();
  if (process.env.GROWTH_DRYCHECK === "1") return await dryCheck();
  if (phaseArg === "adopt") await phaseAdopt();
  else if (phaseArg === "adhere") await phaseAdhere();
  else throw new Error(`unknown --phase=${phaseArg} (use adopt|adhere)`);
}

main().catch((e) => {
  console.error("\n!! growth-loop error:", e);
  process.exit(2);
});
