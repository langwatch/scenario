/**
 * derisk-alwaysenforced — pre-flight for the #784 two-tier ALWAYS-ENFORCED tier,
 * 0 Max bucket. Invokes the REAL `hooks-lib.mjs h3-verify` hook exactly as Claude
 * Code would (canned stdin + baked env + a canned tee'd substrate), against the
 * REAL gpt-5.1 per-procedure gate, and asserts the always-enforced union fires
 * correctly and — critically — does NOT over-fire on distractor turns:
 *
 *   A. Task turn: the sheet names an applicable procedure (handle-refund) which
 *      the subject FULLY enacted, but the always-enforced meta-procedures
 *      (done/prove/format/audit/improvise-lookup) were NOT carried out -> the gate
 *      UNIONS the always-enforced tier into `enforced` (enforcedVia includes
 *      "+always") and BLOCKS, naming the always-enforced procedures — while the
 *      fully-served handle-refund is NOT blocked (per-procedure discrimination
 *      intact: an always-enforced miss blocks even when the sheet's own procedure
 *      is complete).
 *   B. Pure-distractor turn: the sheet names NO applicable procedure -> allow-noop,
 *      the always-enforced tier is NOT added (over-fire guard: `enforced` is empty
 *      so nothing unions in), enforcedVia has no "+always", 0 OpenAI calls.
 *
 * Uses OpenAI only (gpt-5.1) — never the Claude Max bucket. The expected
 * always-enforced id set is derived from the corpus via the REAL
 * `alwaysEnforcedIds(loadCorpus(...))` (source of truth), so it auto-adapts if the
 * tier grows.
 *
 *   ADHERENCE_OPENAI_ENV=/path/to/.env node derisk-alwaysenforced.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { loadCorpus, alwaysEnforcedIds } from "./strategies/hooks-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "strategies", "hooks-lib.mjs");
const CORPUS = join(HERE, "corpus");
const NODE = process.execPath;
const OPENAI_ENV = process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";
const JUDGE_MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? "gpt-5.1";

// Source-of-truth expected always-enforced set (from the REAL corpus metadata).
const ALWAYS = alwaysEnforcedIds(loadCorpus(CORPUS)).sort();

let _tid = 0;
/** One tee stream line: assistant tool_use. */
function tu(name, input) {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t" + ++_tid, name, input }] } });
}
/** One tee stream line: tool_result (as user). */
function tr(content) {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: String(content) }] } });
}
function human(text) {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}

// handle-refund fully enacted (4 steps: intake/confirm, process refund, record charge, confirm state).
// Deliberately carries NO completion-note write (done) and NO audit-log entry (audit) — the ledger
// line records a refund, not a meta audit of changes — so the always-enforced tier has a real miss.
const HANDLE_REFUND_DONE = [
  human("A customer wants their money back for the returned order; make it right."),
  tu("Read", { file_path: "state/charge-8842.json" }),
  tr('{"charge_id":"ch_8842","order_id":"ord_8842","amount":129.9,"status":"captured"}'),
  tu("Read", { file_path: "state/orders/ord_8842.json" }),
  tr('{"order_id":"ord_8842","status":"returned"}'),
  tu("Edit", { file_path: "state/charge-8842.json", old_string: '"status":"captured"', new_string: '"status":"refunded","refund_amount":129.9,"reason_code":"returned"' }),
  tr("File updated: charge-8842.json now status=refunded, refund of 129.90 processed"),
  tu("Edit", { file_path: "state/ledger.jsonl", old_string: '{"entry":"e_2002"', new_string: '{"entry":"e_2003","ref":"ch_8842","type":"refund","amount":-129.9}\n{"entry":"e_2002"' }),
  tr("Ledger appended: refund entry e_2003 recorded against ch_8842"),
  tu("Read", { file_path: "state/charge-8842.json" }),
  tr('{"charge_id":"ch_8842","status":"refunded","refund_amount":129.9}'),
];

// Distractor-only turn: unrelated gateway/certificate work, nothing refund-related.
const DISTRACTOR = [
  human("While you're at it, check whether the gateway certificate is close to expiry."),
  tu("Read", { file_path: "state/gateway-cert.json" }),
  tr('{"cert":"gw","expires":"2027-01-01"}'),
];

function setupCase(label, streamLines, sheetText) {
  const root = mkdtempSync(join(tmpdir(), `derisk-ae-${label}-`));
  const transcriptDir = join(root, ".transcript");
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(join(transcriptDir, "1.stream.jsonl"), streamLines.join("\n") + "\n");
  writeFileSync(join(transcriptDir, ".counter"), "1");
  const sheetFile = join(root, "last-sheet.txt");
  writeFileSync(sheetFile, sheetText);
  const hookLog = join(root, "hooks.jsonl");
  return { root, transcriptDir, sheetFile, hookLog };
}

function invoke(env, stdin) {
  return spawnSync(NODE, [HOOK, "h3-verify"], {
    input: stdin,
    encoding: "utf8",
    env: {
      ...process.env,
      ADHERENCE_CORPUS_DIR: CORPUS,
      ADHERENCE_HOOK_LOG: env.hookLog,
      ADHERENCE_SHEET_FILE: env.sheetFile,
      ADHERENCE_TRANSCRIPT_DIR: env.transcriptDir,
      // ONLY handle-refund is applicable — isolates the block to the always-enforced
      // tier (no reconcile-invoice chain hop to confound Case A).
      ADHERENCE_APPLICABLE: "handle-refund",
      ADHERENCE_RETRY_CAP: "3",
      ADHERENCE_JUDGE_MODEL: JUDGE_MODEL,
      ADHERENCE_OPENAI_ENV: OPENAI_ENV,
      // Force the hook to read the key from the .env file (don't leak ours in).
      OPENAI_API_KEY: "",
    },
    timeout: 240_000,
  });
}

function lastStopEvent(hookLog) {
  if (!existsSync(hookLog)) return null;
  const lines = readFileSync(hookLog, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o.mode === "h3-verify" && o.event === "stop") return o;
    } catch {}
  }
  return null;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} -- ${detail}`); }
}

const has = (arr, id) => (arr ?? []).includes(id);
const proc = (ev, id) => (ev?.perProc ?? []).find((p) => p.id === id);

console.log(`\n=== derisk-alwaysenforced (#784 always-enforced tier; gpt-5.1 gate; 0 Max bucket) ===`);
console.log(`hook: ${HOOK}\njudge: ${JUDGE_MODEL}  openaiEnv: ${OPENAI_ENV}`);
console.log(`always-enforced ids (from corpus): ${JSON.stringify(ALWAYS)}\n`);

// Guard: the tier must be authored + parsed, or every downstream assertion is vacuous.
check("corpus exposes >=1 always-enforced procedure", ALWAYS.length >= 1, `ALWAYS=${JSON.stringify(ALWAYS)}`);
check("always-enforced tier includes done + audit (Case A targets)", has(ALWAYS, "done") && has(ALWAYS, "audit"), JSON.stringify(ALWAYS));

// --- Case A: applicable proc DONE, always-enforced tier NOT done -> BLOCK via +always ---
{
  console.log("\nCase A: handle-refund DONE, always-enforced tier (done/audit/...) NOT done  -> expect BLOCK via +always");
  const c = setupCase("A", HANDLE_REFUND_DONE, "Governing procedure: handle-refund. Carry out its numbered steps in full.");
  const r = invoke(c, JSON.stringify({ stop_hook_active: false }));
  const ev = lastStopEvent(c.hookLog);
  const stdout = (r.stdout || "").trim();
  let blockJson = null;
  try { blockJson = stdout ? JSON.parse(stdout) : null; } catch {}
  console.log(`  exit=${r.status} decision=${ev?.decision} enforcedVia=${ev?.enforcedVia}`);
  console.log(`  enforced=${JSON.stringify(ev?.enforced)}`);
  console.log(`  blockedProcs=${JSON.stringify(ev?.blockedProcs)}`);
  console.log(`  perProc=${JSON.stringify((ev?.perProc ?? []).map((p) => ({ id: p.id, followed: p.followed, ok: p.judgeOk })))}`);

  check("exit 0", r.status === 0, `exit=${r.status} stderr=${(r.stderr || "").slice(0, 300)}`);
  check("decision=block", ev?.decision === "block", `decision=${ev?.decision}`);
  check("stdout carries decision:block", blockJson?.decision === "block", `stdout=${stdout.slice(0, 200)}`);
  check("enforcedVia tagged +always", typeof ev?.enforcedVia === "string" && ev.enforcedVia.includes("+always"), `enforcedVia=${ev?.enforcedVia}`);
  check("enforced still includes the applicable proc handle-refund", has(ev?.enforced, "handle-refund"), JSON.stringify(ev?.enforced));
  check("enforced unions in the WHOLE always-enforced tier", ALWAYS.every((id) => has(ev?.enforced, id)), `enforced=${JSON.stringify(ev?.enforced)} expected⊇${JSON.stringify(ALWAYS)}`);
  check("every enforced proc was judged (1 applicable + tier)", (ev?.perProc ?? []).length === 1 + ALWAYS.length, `perProc len=${(ev?.perProc ?? []).length} expected=${1 + ALWAYS.length}`);
  check("blocked names always-enforced 'done'", has(ev?.blockedProcs, "done"), JSON.stringify(ev?.blockedProcs));
  check("blocked names always-enforced 'audit'", has(ev?.blockedProcs, "audit"), JSON.stringify(ev?.blockedProcs));
  check("did NOT block the fully-served handle-refund (per-proc discrimination)", !has(ev?.blockedProcs, "handle-refund"), JSON.stringify(ev?.blockedProcs));
  check("handle-refund judged followed=true", proc(ev, "handle-refund")?.followed === true, JSON.stringify(proc(ev, "handle-refund")));
  check("'done' judged followed=false (real miss, not a judge error)", proc(ev, "done")?.judgeOk === true && proc(ev, "done")?.followed === false, JSON.stringify(proc(ev, "done")));
  check("'audit' judged followed=false (real miss, not a judge error)", proc(ev, "audit")?.judgeOk === true && proc(ev, "audit")?.followed === false, JSON.stringify(proc(ev, "audit")));
  rmSync(c.root, { recursive: true, force: true });
}

// --- Case B: distractor turn, sheet names no applicable proc -> allow-noop, NO over-fire, 0 OpenAI ---
{
  console.log("\nCase B: distractor turn (sheet names no applicable proc)  -> expect allow-noop, no +always, 0 OpenAI");
  const c = setupCase("B", DISTRACTOR, "No governing procedure applies to this request.");
  const r = invoke(c, JSON.stringify({ stop_hook_active: false }));
  const ev = lastStopEvent(c.hookLog);
  console.log(`  exit=${r.status} decision=${ev?.decision} enforcedVia=${ev?.enforcedVia} enforced=${JSON.stringify(ev?.enforced)}`);
  check("exit 0", r.status === 0, `exit=${r.status}`);
  check("decision=allow-noop", ev?.decision === "allow-noop", `decision=${ev?.decision}`);
  check("enforced is empty (no applicable proc)", (ev?.enforced ?? []).length === 0, JSON.stringify(ev?.enforced));
  check("always-enforced tier NOT added on a distractor (no over-fire)", !(typeof ev?.enforcedVia === "string" && ev.enforcedVia.includes("+always")), `enforcedVia=${ev?.enforcedVia}`);
  check("0 per-proc judge calls on a distractor turn (0 OpenAI)", (ev?.perProc ?? []).length === 0, `perProc len=${(ev?.perProc ?? []).length}`);
  rmSync(c.root, { recursive: true, force: true });
}

console.log(`\n=== derisk-alwaysenforced result: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
