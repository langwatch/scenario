/**
 * sandbox — `buildSandbox(strategy)`: an isolated, authenticated, cred-safe home
 * for ONE Claude Code subject session (plan file #1, constraints L1/L2/L3/L5).
 *
 * Layout (all under `.sandbox/<runId>/`, gitignored):
 *   .claude/                      CLAUDE_CONFIG_DIR (the GLOBAL config)
 *     .credentials.json           -> SYMLINK to the real creds (L1; never copied)
 *     CLAUDE.md                    frames the subject as a procedure-following operator
 *     references/procedures/       -> SYMLINK to the committed corpus (L2; read-only)
 *     settings.json                the strategy's hooks (L3) + a scoped
 *                                   Edit/Write permission allowlist (below)
 *     adherence/hooks-lib.mjs      the sandbox copy the hooks run
 *     adherence/hook-events.jsonl  hook-fired evidence
 *     adherence/last-sheet.txt     compile->verify handoff
 *   project/                      CLEAN cwd (asserted: no CLAUDE.md / .claude)
 *   .transcript/                  the tee'd stream-json substrate (workDir = root)
 *   claude-shim.sh                the claudeBin tee shim
 *
 * Isolation invariants:
 *   L1 — `.credentials.json` is a SYMLINK whose realpath is OUTSIDE the repo
 *        (a bare sandbox is "Not logged in"; there is no ANTHROPIC_API_KEY).
 *   L2 — the corpus is delivered ONLY via the global config; the cwd stays clean
 *        so distractor files cannot leak procedures.
 *   L3 — hooks live in `$CLAUDE_CONFIG_DIR/settings.json`; they fire headlessly
 *        under `claude -p` at DEFAULT permissions. `permissions.allow` there
 *        pre-approves ONLY `Edit`/`Write` (never `bypassPermissions`/
 *        `--dangerously-skip-permissions`) so a diligent subject's file
 *        mutations against the seeded project state are not silently denied
 *        (#784 fix: the first live H1 run's Edit/Write calls were denied with
 *        "you haven't granted it yet", NOT a content/old_string mismatch —
 *        without this, followed=true is unreachable no matter how the corpus
 *        or seed files are shaped). Bash and every other tool stay gated.
 *   L5 — snapshot/restore `process.env.CLAUDE_CONFIG_DIR`, assert the child's
 *        configDir, and use a FRESH workDir per session so the substrate is
 *        unambiguous.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureTranscriptDir, writeTeeShim, TRANSCRIPT_SUBDIR } from "./tee-substrate.ts";
import { materializeBaseline } from "./strategies/baseline.ts";
import { materializeH1 } from "./strategies/h1.ts";
import type { MaterializeCtx, StrategyMaterialization } from "./strategies/common.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = realpathSync(join(HERE, "..", "..", "..", ".."));
export const CORPUS_DIR = join(HERE, "corpus");
/**
 * The sandbox lives OUTSIDE the repo tree (isolation hardening). The subject's
 * cwd is `<SANDBOX_ROOT>/<runId>/project`; if it ever traverses `..`, it climbs
 * into a scratch dir, never the real repo — so it cannot read the corpus source,
 * the plan, or any other real file that would contaminate the measurement. (A
 * sandbox nested inside the repo, as in the first live run, left every absolute
 * path carrying the repo prefix and one `cd ..` away from real files.) NOTE:
 * this is path isolation, not kernel containment — for the increment-3 scored
 * matrix the subject should additionally run under a container/bwrap so absolute
 * paths elsewhere on the box are unreachable too.
 */
const SANDBOX_ROOT = process.env.ADHERENCE_SANDBOX_ROOT ?? join(tmpdir(), "adherence-784-sandboxes");
const HOOKS_LIB_SRC = join(HERE, "strategies", "hooks-lib.mjs");

export type StrategyName = "baseline" | "h1";

export interface Sandbox {
  runId: string;
  root: string;
  /** CLAUDE_CONFIG_DIR. */
  configDir: string;
  /** Clean cwd for the subject. */
  projectDir: string;
  /** workDir the judge reads the substrate from (== root). */
  workDir: string;
  transcriptDir: string;
  /** The claudeBin the adapter spawns (tees stdout). */
  shimPath: string;
  hookLog: string;
  sheetFile: string;
  corpusDir: string;
  strategy: StrategyMaterialization;
  /** realpath of the symlinked creds (asserted outside the repo). */
  credsRealpath: string;
  /** Env the child (claude) must run with. Apply via {@link applyChildEnv}. */
  childEnv: { CLAUDE_CONFIG_DIR: string; ADHERENCE_TRANSCRIPT_DIR: string };
}

function which(bin: string): string {
  const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  const p = r.stdout.trim().split("\n").pop() ?? "";
  if (!p) throw new Error(`cannot resolve ${bin} on PATH`);
  return p;
}

const SUBJECT_CLAUDE_MD = `# Operating under a procedure corpus

You are an operations assistant working through back-office requests in a live session.

The team maintains a corpus of written operating **procedures** under
\`references/procedures/<id>/PROCEDURE.md\` in this config directory. These
procedures are BINDING: whenever a request corresponds to a procedure, you MUST
follow that procedure's numbered steps, in order, carrying out EACH step as a
concrete action (use your tools — read the relevant state, run the command or
write the file the step calls for — do not merely describe it). If a procedure
names a transitive hand-off ("then follow procedure X"), you must carry out X's
steps too before the task is complete.

Retrieval assistance may be injected into your context before each request to
help you find the applicable procedure in the large corpus. Treat any injected
procedure text or instruction sheet as authoritative for that turn.

Work ONLY inside the current working directory. Do not \`cd\` above it, and do not
read, search, or write files outside it — everything you need for a request is
either already in this directory or injected into your context. Keep going until
the applicable procedure has been fully carried out as concrete actions.
`;

/**
 * Build a fresh isolated sandbox for one session under the given strategy.
 * Destroys any prior sandbox at the same runId first (fresh workDir, L5).
 */
export function buildSandbox(
  strategy: StrategyName,
  opts: { runId?: string; retrievalK?: number; haikuModel?: string; corpusDir?: string } = {},
): Sandbox {
  const runId = opts.runId ?? `${strategy}-${Date.now()}`;
  const root = join(SANDBOX_ROOT, runId);
  // Isolation invariant: the sandbox (and thus the subject's cwd) must be OUTSIDE
  // the repo tree, so a `..` traversal cannot reach real files.
  const repoReal = realpathSync(REPO_ROOT);
  if (root === repoReal || root.startsWith(repoReal + "/")) {
    throw new Error(`sandbox root is INSIDE the repo (${root}); set ADHERENCE_SANDBOX_ROOT outside ${repoReal}`);
  }
  rmSync(root, { recursive: true, force: true });

  const configDir = join(root, ".claude");
  const projectDir = join(root, "project");
  const adherenceDir = join(configDir, "adherence");
  const refsDir = join(configDir, "references");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(adherenceDir, { recursive: true });
  mkdirSync(refsDir, { recursive: true });
  const transcriptDir = ensureTranscriptDir(root);

  // L1: symlink real creds (never copy a secret into the repo tree).
  const realCreds = realpathSync(join(homedir(), ".claude", ".credentials.json"));
  symlinkSync(realCreds, join(configDir, ".credentials.json"));

  // L2: corpus via the global config ONLY (symlink; read-only). CLAUDE.md frames it.
  const corpusDir = opts.corpusDir ?? CORPUS_DIR;
  symlinkSync(corpusDir, join(refsDir, "procedures"));
  writeFileSync(join(configDir, "CLAUDE.md"), SUBJECT_CLAUDE_MD, "utf8");

  // L3: strategy hooks. Copy the runtime into the sandbox so it is self-contained.
  const hookLibPath = join(adherenceDir, "hooks-lib.mjs");
  copyFileSync(HOOKS_LIB_SRC, hookLibPath);
  const hookLog = join(adherenceDir, "hook-events.jsonl");
  const sheetFile = join(adherenceDir, "last-sheet.txt");
  const ctx: MaterializeCtx = {
    hookLibPath,
    corpusDir,
    hookLog,
    sheetFile,
    retrievalK: opts.retrievalK ?? 8,
    haikuModel: opts.haikuModel ?? "claude-haiku-4-5",
    nodeBin: which("node"),
  };
  const materialized = strategy === "h1" ? materializeH1(ctx) : materializeBaseline(ctx);
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify(
      {
        // Pre-approve the two file-mutation tools a diligent subject NEEDS to
        // carry out a procedure's steps against the seeded project state
        // (Edit/Write), scoped to this one disposable, isolated sandbox. This
        // is NOT --dangerously-skip-permissions/bypassPermissions (L3 still
        // forbids that) — Bash and every other tool stay under DEFAULT
        // permission handling. Evidence this is load-bearing: the first live H1
        // run's Edit/Write calls into the clean project cwd were denied
        // ("Claude requested permissions to write to <path>, but you haven't
        // granted it yet") even though the Edit's `old_string` matched the
        // seeded file byte-for-byte (NOT a content/old_string mismatch) — so
        // followed=true was unreachable regardless of corpus step count or
        // seed-file shape. See `.sandbox/h1-1783740882052/.transcript/4.stream.jsonl`.
        permissions: { allow: ["Edit", "Write"] },
        hooks: materialized.hooks,
      },
      null,
      2,
    ),
    "utf8",
  );

  // Tee shim = the claudeBin the adapter spawns.
  const shimPath = join(root, "claude-shim.sh");
  writeTeeShim(shimPath, which("claude"));
  chmodSync(shimPath, 0o755);

  // Assertions (L2/L5): clean cwd, config isolated, creds outside repo.
  assertCleanCwd(projectDir);
  const credsRealpath = realpathSync(join(configDir, ".credentials.json"));
  if (credsRealpath.startsWith(realpathSync(REPO_ROOT))) {
    throw new Error(`cred symlink realpath is INSIDE the repo: ${credsRealpath}`);
  }

  return {
    runId,
    root,
    configDir,
    projectDir,
    workDir: root,
    transcriptDir,
    shimPath,
    hookLog,
    sheetFile,
    corpusDir,
    strategy: materialized,
    credsRealpath,
    childEnv: {
      CLAUDE_CONFIG_DIR: configDir,
      ADHERENCE_TRANSCRIPT_DIR: join(root, TRANSCRIPT_SUBDIR),
    },
  };
}

/** Assert the cwd carries no procedure-leaking CLAUDE.md / .claude (L2). */
export function assertCleanCwd(projectDir: string): void {
  for (const stray of ["CLAUDE.md", ".claude"]) {
    if (existsSync(join(projectDir, stray))) {
      throw new Error(`cwd is not clean (L2 violation): found ${stray} in ${projectDir}`);
    }
  }
}

/**
 * Apply the sandbox's child env to `process.env` (so the adapter's spawn
 * inherits it), snapshotting the prior values. Returns a restore fn (L5). Assert
 * the applied configDir is the sandbox's, never the real `~/.claude`.
 */
export function applyChildEnv(sandbox: Sandbox): () => void {
  const keys = Object.keys(sandbox.childEnv) as Array<keyof Sandbox["childEnv"]>;
  const prior = new Map<string, string | undefined>();
  for (const k of keys) {
    prior.set(k, process.env[k]);
    process.env[k] = sandbox.childEnv[k];
  }
  const realConfig = realpathSync(join(homedir(), ".claude"));
  if (process.env.CLAUDE_CONFIG_DIR === realConfig) {
    throw new Error("CLAUDE_CONFIG_DIR resolved to the REAL ~/.claude — isolation broken");
  }
  if (process.env.CLAUDE_CONFIG_DIR !== sandbox.configDir) {
    throw new Error(
      `CLAUDE_CONFIG_DIR is ${process.env.CLAUDE_CONFIG_DIR}, expected sandbox ${sandbox.configDir}`,
    );
  }
  return () => {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
