/**
 * gate-a — GATE A / F0 / AC2: prove the LIVE substrate the judge would read
 * carries real action records on this box (claude 2.1.207).
 *
 * Builds a minimal isolated sandbox, runs ONE real
 *   claude -p --output-format stream-json --verbose "list the files here then read one"
 * THROUGH the tee shim, and asserts the tee'd substrate contains
 * >= 1 tool_use AND >= 1 tool_result. Also reports whether the on-disk flat
 * session JSONL was full or an `ai-title` stub.
 *
 * Isolation (per plan L1/L2/L5):
 *   - CLAUDE_CONFIG_DIR = <sandbox>/.claude  with `.credentials.json` SYMLINKED
 *     from the real dir (a bare sandbox is "Not logged in"; no ANTHROPIC_API_KEY).
 *   - CLEAN cwd = <sandbox>/project (asserted: no CLAUDE.md / .claude).
 *   - Fresh transcript dir; the tee'd stdout is the PRIMARY substrate.
 *
 * This is the ONLY subscription-drawing claude -p session. On a 429 (the shared
 * Max bucket is throttled) it reports THROTTLED (no quota consumed) rather than a
 * false FAIL — re-run when the bucket frees.
 *
 * Run:  tsx gate-a.ts
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureTranscriptDir, readSubstrate, writeTeeShim, TRANSCRIPT_SUBDIR } from "./tee-substrate.ts";
import { extractActionLog } from "./normalize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX = join(HERE, ".sandbox", "gate-a"); // gitignored
const PROMPT = "list the files here then read one";
const TIMEOUT_MS = 120_000;

function which(bin: string): string {
  const r = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  const p = r.stdout.trim().split("\n").pop() ?? "";
  if (!p) throw new Error(`cannot resolve ${bin} on PATH`);
  return p;
}

function grepCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function main(): void {
  console.log("================ GATE A — live substrate integrity (F0 / AC2) ================");

  // --- build sandbox ---
  rmSync(SANDBOX, { recursive: true, force: true });
  const configDir = join(SANDBOX, ".claude");
  const projectDir = join(SANDBOX, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  ensureTranscriptDir(SANDBOX);

  // L1: symlink real credentials into the sandbox config dir (never copy).
  const realCreds = realpathSync(join(homedir(), ".claude", ".credentials.json"));
  const linkPath = join(configDir, ".credentials.json");
  symlinkSync(realCreds, linkPath);
  // trivial global CLAUDE.md
  writeFileSync(join(configDir, "CLAUDE.md"), "# Sandbox\nYou are in an isolated sandbox. Be brief.\n", "utf8");

  // L2: clean cwd — trivial files to read, and NO CLAUDE.md/.claude.
  writeFileSync(join(projectDir, "README.txt"), "This project has two files. Nothing secret here.\n", "utf8");
  writeFileSync(join(projectDir, "notes.txt"), "alpha\nbeta\ngamma\n", "utf8");
  const cwdClean = !existsSync(join(projectDir, "CLAUDE.md")) && !existsSync(join(projectDir, ".claude"));

  // tee shim wrapping the real claude.
  const realClaude = which("claude");
  const shimPath = join(SANDBOX, "claude-shim.sh");
  writeTeeShim(shimPath, realClaude);
  chmodSync(shimPath, 0o755);

  console.log(`sandbox ............. ${SANDBOX}`);
  console.log(`CLAUDE_CONFIG_DIR ... ${configDir}`);
  console.log(`creds symlink ....... ${linkPath} -> ${realCreds}`);
  console.log(`cwd (clean) ......... ${projectDir}  (no CLAUDE.md/.claude: ${cwdClean})`);
  console.log(`real claude ......... ${realClaude}`);
  console.log(`prompt .............. ${JSON.stringify(PROMPT)}`);
  console.log("");

  // --- run ONE claude -p through the tee ---
  console.log("running one claude -p session through the tee ...");
  const run = spawnSync(
    "bash",
    [shimPath, "-p", "--output-format", "stream-json", "--verbose", PROMPT],
    {
      cwd: projectDir,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        ADHERENCE_TRANSCRIPT_DIR: join(SANDBOX, TRANSCRIPT_SUBDIR),
      },
    },
  );
  const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  console.log(`  exit=${run.status} signal=${run.signal ?? "-"} timedOut=${run.error?.message?.includes("ETIMEDOUT") ?? false}`);

  // --- read the tee'd substrate ---
  const transcriptDir = join(SANDBOX, TRANSCRIPT_SUBDIR);
  let teeText = "";
  try {
    for (const f of readdirSync(transcriptDir).filter((f) => f.endsWith(".stream.jsonl"))) {
      teeText += readFileSync(join(transcriptDir, f), "utf8");
    }
  } catch {
    /* none */
  }

  // Raw grep counts (the brief's required evidence).
  const rawToolUse = grepCount(teeText, '"type":"tool_use"');
  const rawToolResult = grepCount(teeText, '"type":"tool_result"');

  // Parsed-substrate counts (what the judge actually reads).
  const turns = readSubstrate(SANDBOX);
  const actionLog = extractActionLog(turns);
  const parsedToolUse = actionLog.filter((a) => a.kind === "tool_use").length;
  const parsedToolResult = actionLog.filter((a) => a.kind === "tool_result").length;

  // Throttle / auth detection.
  const throttled = /rate_limit|429|overloaded/i.test(combined) || /rate_limit|429/i.test(teeText);
  const notLoggedIn = /not logged in|\/login|invalid api key|authentication/i.test(combined + teeText);

  console.log("");
  console.log("---- tee'd substrate (PRIMARY — what the judge reads) ----");
  console.log(`  raw    grep "type":"tool_use"    = ${rawToolUse}`);
  console.log(`  raw    grep "type":"tool_result" = ${rawToolResult}`);
  console.log(`  parsed tool_use  (readSubstrate) = ${parsedToolUse}`);
  console.log(`  parsed tool_result (readSubstrate)= ${parsedToolResult}`);
  console.log(`  normalized turns .................= ${turns.length}`);

  // --- on-disk flat JSONL: full or ai-title stub? ---
  const flat = findFlatJsonl(configDir);
  console.log("");
  console.log("---- on-disk flat session JSONL (informational; NOT the judged substrate) ----");
  if (!flat) {
    console.log("  (no flat session JSONL found under CLAUDE_CONFIG_DIR/projects)");
  } else {
    const body = readFileSync(flat.path, "utf8");
    const hasTool = /"type":"tool_use"|"type":"tool_result"/.test(body);
    const looksStub = /ai-?title|isTitleMessage|"type":"summary"/i.test(body) && !hasTool;
    console.log(`  path .... ${flat.path}`);
    console.log(`  lines ... ${body.split("\n").filter(Boolean).length}, carries tool records: ${hasTool}`);
    console.log(`  verdict . ${hasTool ? "FULL (has tool records)" : looksStub ? "ai-title STUB (no tool records)" : "no tool records"}`);
  }

  // --- verdict ---
  const pass = rawToolUse >= 1 && rawToolResult >= 1;
  console.log("");
  console.log("================ GATE A verdict ================");
  if (throttled && !pass) {
    console.log("RESULT: THROTTLED — the shared Claude Max bucket returned a rate limit (no quota consumed).");
    console.log("        Re-run gate-a.ts when the bucket frees. Harness is verified end-to-end offline.");
    process.exit(3);
  }
  if (notLoggedIn && !pass) {
    console.log("RESULT: AUTH FAIL — sandbox reported not-logged-in. Check the .credentials.json symlink.");
    process.exit(4);
  }
  console.log(`tee'd substrate has >=1 tool_use AND >=1 tool_result: ${pass ? "YES" : "NO"}`);
  console.log(`GATE A: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

/** Find the most-recent flat session JSONL claude wrote under the config dir. */
function findFlatJsonl(configDir: string): { path: string } | null {
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return null;
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) found.push(p);
    }
  };
  walk(projects);
  return found.length ? { path: found.sort()[found.length - 1] } : null;
}

main();
