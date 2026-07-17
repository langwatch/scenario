/**
 * prove-claude-gate — offline de-risk (#784 Claude-gate): confirm the SHIPPED gate
 * (per-procedure judge via the OAuth Claude Messages API, callHaiku) returns the
 * SAME strict {followed,missingSteps,reasoning} JSON contract as the gpt-5.1 gate,
 * and DISCRIMINATES a fully-enacted procedure (followed=true) from a skipped one
 * (followed=false). Cheap: a few Claude calls, NO claude -p subject, NO scenario.run.
 *
 *   tsx prove-claude-gate.mjs
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  callHaiku,
  buildPerProcJudgeSystem,
  buildPerProcJudgeUser,
  parsePerProcVerdict,
  loadCorpus,
} from "./strategies/hooks-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CREDS = join(process.env.HOME ?? "/home/ubuntu", ".claude/.credentials.json");
const corpus = loadCorpus(join(HERE, "corpus"));
const byId = new Map(corpus.map((c) => [c.id, c]));

// Two canned vendor action logs (string form the gate judges from).
const LOG_GRANT_DONE = [
  "Read(state/role-request-3307.json) -> {requested_scope, approval_ref: att_3307}",
  "Read(state/audit-ledger.jsonl) -> existing role_bindings",
  "Read(state/intake-3307.json) -> contract dates",
  'Edit(state/audit-ledger.jsonl) -> appended {"entry":"ab_9007","subject":"acct_5507","role_binding":"vendor-standard","status":"active","expires_at":"2028-07-10","expiry_basis":"contract end"}',
  "Read(state/audit-ledger.jsonl) -> verified the new binding is present with expires_at",
].join("\n");

const LOG_GRANT_MISSING = [
  "Read(state/intake-3307.json) -> supplier profile",
  'Write(state/review-board.jsonl) -> appended {"supplier_id":"s_3307","approval":"approved"}',
  "Read(state/billing-accounts.jsonl) -> existing accounts",
  'Write(state/billing-accounts.jsonl) -> appended {"account_id":"acct_5507","supplier_id":"s_3307","tier":"standard","active":true}',
  "(no action touching state/audit-ledger.jsonl role_binding / access grant)",
].join("\n");

const CASES = [
  { proc: "grant-access", log: LOG_GRANT_DONE, expect: true, label: "grant-access ENACTED" },
  { proc: "grant-access", log: LOG_GRANT_MISSING, expect: false, label: "grant-access SKIPPED" },
];

async function main() {
  const rows = [];
  for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5"]) {
    for (const c of CASES) {
      const body = byId.get(c.proc)?.body ?? "(procedure body missing)";
      const res = await callHaiku(
        buildPerProcJudgeSystem(),
        buildPerProcJudgeUser(c.proc, body, c.log),
        { model, credentialsPath: CREDS },
      );
      const v = res.ok ? parsePerProcVerdict(res.text) : null;
      const contractOk = v !== null; // parseable strict JSON
      const judgeOk = v !== null && v.followed === c.expect;
      rows.push({ model, label: c.label, http: res.status, ok: res.ok, contractOk, followed: v?.followed, expect: c.expect, judgeOk });
      console.log(
        `${model.padEnd(20)} ${c.label.padEnd(22)} http=${res.status} contract=${contractOk ? "OK" : "BROKEN"} followed=${String(v?.followed)} expect=${c.expect} ${judgeOk ? "✓" : contractOk ? "✗judgment" : "✗contract"}`,
      );
    }
  }
  const haiku = rows.filter((r) => r.model === "claude-haiku-4-5");
  const haikuContract = haiku.every((r) => r.contractOk);
  const haikuDiscriminates = haiku.every((r) => r.judgeOk);
  console.log("");
  console.log(`HAIKU gate contract (parseable strict JSON): ${haikuContract ? "PASS" : "FAIL"}`);
  console.log(`HAIKU gate discriminates enacted vs skipped: ${haikuDiscriminates ? "PASS" : "FAIL"}`);
  const sonnet = rows.filter((r) => r.model === "claude-sonnet-4-5");
  const sonnetRan = sonnet.some((r) => r.ok);
  console.log(
    sonnetRan
      ? `SONNET gate contract: ${sonnet.every((r) => r.contractOk) ? "PASS" : "FAIL"}  discriminates: ${sonnet.every((r) => r.judgeOk) ? "PASS" : "FAIL"}`
      : `SONNET gate: could not run (HTTP ${sonnet.map((r) => r.http).join("/")} — likely 429 bucket contention; Haiku proves the Claude-gate contract)`,
  );
  console.log("DONE_MARKER prove-claude-gate");
  process.exit(haikuContract && haikuDiscriminates ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
