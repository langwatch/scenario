/**
 * derisk-h3 — pre-flight for the H3 per-procedure Stop gate, 0 Max bucket.
 * Invokes the REAL `hooks-lib.mjs h3-verify` hook exactly as Claude Code would
 * (canned stdin + baked env + a canned tee'd substrate), against the REAL gpt-5.1
 * judge, and asserts the enforcement path fires correctly. This is the evidence
 * that the per-procedure gate is SOUND even though, in the live H3 run, it was
 * never exercised (the subject completed both procedures unforced → blocks=0):
 *
 *   A. handle-refund fully enacted, reconcile-invoice NOT  -> decision=block,
 *      blockedProcs=[reconcile-invoice] ONLY  (the per-procedure discrimination
 *      H2's aggregate gate lacked — a well-served proc can't mask a skipped one).
 *   B. sheet names NO applicable procedure (distractor turn) -> allow-noop
 *      (0 OpenAI calls; proves distractor turns are never blocked/cap-hit).
 *   C. BOTH procedures fully enacted -> allow-complete (proves it releases when
 *      done, so the live run won't spuriously cap-hit).
 *
 * Uses OpenAI only (gpt-5.1) — never the Claude Max bucket.
 *
 *   ADHERENCE_OPENAI_ENV=/path/to/.env node derisk-h3.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "strategies", "hooks-lib.mjs");
const CORPUS = join(HERE, "corpus");
const NODE = process.execPath;
const OPENAI_ENV = process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";
const JUDGE_MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? "gpt-5.1";

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

// reconcile-invoice fully enacted (4 steps: gather from report, compare to balance, resolve discrepancy, confirm settlement).
const RECONCILE_DONE = [
  tu("Read", { file_path: "state/reconciliation-8842.json" }),
  tr('{"report_id":"rec_8842","source_of_truth_balance":0.0}'),
  tu("Read", { file_path: "state/invoice-8842.json" }),
  tr('{"invoice_id":"inv_8842","balance":129.9}'),
  tu("Edit", { file_path: "state/invoice-8842.json", old_string: '"balance": 129.9', new_string: '"balance": 0.0' }),
  tr("Invoice inv_8842 balance brought into agreement with source of truth: 0.00"),
  tu("Edit", { file_path: "state/settlement-8842.json", old_string: '"settled": false', new_string: '"settled": true' }),
  tr("Settlement flag for ord_8842 confirmed: settled=true"),
];

// Distractor-only turn: unrelated gateway/certificate work, nothing refund/reconcile.
const DISTRACTOR = [
  human("While you're at it, check whether the gateway certificate is close to expiry."),
  tu("Read", { file_path: "state/gateway-cert.json" }),
  tr('{"cert":"gw","expires":"2027-01-01"}'),
];

function setupCase(label, streamLines, sheetText) {
  const root = mkdtempSync(join(tmpdir(), `derisk-h3-${label}-`));
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
      ADHERENCE_APPLICABLE: "handle-refund,reconcile-invoice",
      ADHERENCE_RETRY_CAP: "3",
      ADHERENCE_JUDGE_MODEL: JUDGE_MODEL,
      ADHERENCE_OPENAI_ENV: OPENAI_ENV,
      // Force the hook to read the key from the .env file (don't leak ours in).
      OPENAI_API_KEY: "",
    },
    timeout: 180_000,
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

console.log(`\n=== derisk-h3 (gpt-5.1 per-procedure gate; 0 Max bucket) ===`);
console.log(`hook: ${HOOK}\njudge: ${JUDGE_MODEL}  openaiEnv: ${OPENAI_ENV}\n`);

// --- Case A: handle-refund done, reconcile-invoice NOT -> block naming ONLY reconcile-invoice ---
{
  console.log("Case A: handle-refund DONE, reconcile-invoice SKIPPED  -> expect BLOCK on reconcile-invoice only");
  const c = setupCase("A", HANDLE_REFUND_DONE, "Governing procedure: handle-refund. Then transitive hand-off: reconcile-invoice.");
  const r = invoke(c, JSON.stringify({ stop_hook_active: false }));
  const ev = lastStopEvent(c.hookLog);
  const stdout = (r.stdout || "").trim();
  let blockJson = null;
  try { blockJson = stdout ? JSON.parse(stdout) : null; } catch {}
  console.log(`  exit=${r.status} decision=${ev?.decision} blockedProcs=${JSON.stringify(ev?.blockedProcs)} perProc=${JSON.stringify((ev?.perProc ?? []).map(p => ({ id: p.id, followed: p.followed, ok: p.judgeOk })))}`);
  check("exit 0", r.status === 0, `exit=${r.status} stderr=${(r.stderr || "").slice(0, 300)}`);
  check("decision=block", ev?.decision === "block", `decision=${ev?.decision}`);
  check("stdout carries decision:block", blockJson?.decision === "block", `stdout=${stdout.slice(0, 200)}`);
  check("blocked reconcile-invoice", (ev?.blockedProcs ?? []).includes("reconcile-invoice"), JSON.stringify(ev?.blockedProcs));
  check("did NOT block handle-refund (per-proc discrimination)", !(ev?.blockedProcs ?? []).includes("handle-refund"), JSON.stringify(ev?.blockedProcs));
  check("both procedures judged (2 gpt-5.1 calls)", (ev?.perProc ?? []).length === 2, `perProc len=${(ev?.perProc ?? []).length}`);
  check("no judge errors (gate reached OpenAI + parsed)", (ev?.perProc ?? []).every(p => p.judgeOk), JSON.stringify((ev?.perProc ?? []).map(p => p.status)));
  rmSync(c.root, { recursive: true, force: true });
}

// --- Case B: distractor turn, sheet names no applicable proc -> allow-noop, 0 OpenAI ---
{
  console.log("\nCase B: distractor turn (sheet names no applicable proc)  -> expect allow-noop");
  const c = setupCase("B", DISTRACTOR, "No governing procedure applies to this request.");
  const r = invoke(c, JSON.stringify({ stop_hook_active: false }));
  const ev = lastStopEvent(c.hookLog);
  console.log(`  exit=${r.status} decision=${ev?.decision} enforced=${JSON.stringify(ev?.enforced)}`);
  check("exit 0", r.status === 0, `exit=${r.status}`);
  check("decision=allow-noop", ev?.decision === "allow-noop", `decision=${ev?.decision}`);
  check("no per-proc judge calls on a distractor turn", (ev?.perProc ?? []).length === 0, `perProc len=${(ev?.perProc ?? []).length}`);
  rmSync(c.root, { recursive: true, force: true });
}

// --- Case C: BOTH done -> allow-complete ---
{
  console.log("\nCase C: BOTH procedures fully enacted  -> expect allow-complete (gate releases)");
  const c = setupCase("C", [...HANDLE_REFUND_DONE, ...RECONCILE_DONE], "Governing procedure: handle-refund. Then transitive hand-off: reconcile-invoice.");
  const r = invoke(c, JSON.stringify({ stop_hook_active: false }));
  const ev = lastStopEvent(c.hookLog);
  console.log(`  exit=${r.status} decision=${ev?.decision} perProc=${JSON.stringify((ev?.perProc ?? []).map(p => ({ id: p.id, followed: p.followed, ok: p.judgeOk })))}`);
  check("exit 0", r.status === 0, `exit=${r.status}`);
  check("decision allows (complete)", ev?.decision === "allow-complete" || ev?.decision === "allow-judge-partial", `decision=${ev?.decision}`);
  check("no blocked procedures", (ev?.blockedProcs ?? []).length === 0, JSON.stringify(ev?.blockedProcs));
  check("both judged followed=true", (ev?.perProc ?? []).filter(p => p.followed === true).length === 2, JSON.stringify((ev?.perProc ?? []).map(p => ({ id: p.id, f: p.followed }))));
  rmSync(c.root, { recursive: true, force: true });
}

console.log(`\n=== derisk-h3 result: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
