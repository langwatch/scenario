/**
 * prove-delegation — ZERO subscription cost, 0-bucket proof for the #784
 * "delegation" dimension (`instrument.ts` -> `detectDelegation`).
 *
 * Owner scoping (2026-07-11): delegation is a LOGGED DIMENSION ONLY — no gate
 * or judge reads it. It exists so a delegated-vs-non-delegated gate
 * BLOCK-RATE comparison is possible once a delegation-inducing scenario
 * exists. This proof pins down the ONE thing `detectDelegation` must get
 * right: it counts `tool_use` records named `Task` (the Claude Code
 * subagent-invocation tool) or `Agent`, and ONLY those — ordinary direct tool
 * use (Read/Bash/Write/...) must never false-positive as delegation.
 *
 * Fully offline: builds synthetic `stream-json` substrate with the SAME
 * fixture builders the judge fixtures use (`fixtures/builders.ts`), then runs
 * it through the REAL pipeline (`normalizeTurns` -> `extractActionLog` ->
 * `detectDelegation`) — no LLM call, no API key, no subscription draw.
 *
 * Run:  tsx prove-delegation.ts
 */

import { normalizeTurns, extractActionLog } from "./normalize.ts";
import { detectDelegation } from "./instrument.ts";
import {
  assistantText,
  bash,
  human,
  readFile,
  resultLine,
  systemInit,
  toolResult,
  toolUse,
  write,
} from "./fixtures/builders.ts";
import type { ClaudeStreamMessage } from "./types.ts";

function log(...a: unknown[]): void {
  console.log(...a);
}

// --- case A: DELEGATED — a Task tool_use mixed in with ordinary tool use ---
function caseDelegated(): ClaudeStreamMessage[] {
  const t1 = toolUse("Task", {
    description: "rotate the credential",
    prompt: "Follow the rotate-credential procedure end to end.",
    subagent_type: "coder",
  });
  return [
    systemInit(),
    human("Rotate the signing credential; delegate the legwork if you want."),
    ...readFile("corpus/rotate-credential/PROCEDURE.md", "# Rotate Credential\n..."),
    t1.msg,
    toolResult("subagent report: credential rotated, old grant revoked.", { toolUseId: t1.id }),
    assistantText("Delegated the rotation to a subagent; it reports done."),
    resultLine(),
  ];
}

// --- case B: NON-DELEGATED — only direct tool use, no Task/Agent -----------
function caseDirect(): ClaudeStreamMessage[] {
  return [
    systemInit(),
    human("Rotate the signing credential."),
    ...readFile("corpus/rotate-credential/PROCEDURE.md", "# Rotate Credential\n..."),
    ...bash("rotate-credential --generate", "generated replacement credential cred-9f2a"),
    ...write("/secret-store/signing", "cred-9f2a"),
    assistantText("Rotated the signing credential directly."),
    resultLine(),
  ];
}

// --- case C (bonus): the "Agent"-named tool must ALSO count as delegation --
function caseAgentName(): ClaudeStreamMessage[] {
  const t1 = toolUse("Agent", { description: "handle it" });
  return [
    systemInit(),
    human("Handle the refund."),
    t1.msg,
    toolResult("subagent report: refund issued.", { toolUseId: t1.id }),
    assistantText("Delegated via the Agent tool; done."),
    resultLine(),
  ];
}

function main(): void {
  log("================ prove-delegation — #784 delegation dimension (0-bucket) ================");

  // Gate 1: WITH a Task tool_use (mixed with Read) -> delegated=true, taskCalls
  // counts ONLY the Task record, not every tool_use.
  const aActions = extractActionLog(normalizeTurns(caseDelegated()));
  const aTaskToolUses = aActions.filter((x) => x.kind === "tool_use" && x.name === "Task").length;
  const aTotalToolUses = aActions.filter((x) => x.kind === "tool_use").length;
  const a = detectDelegation(aActions);
  const gate1 =
    a.delegated === true && a.taskCalls === 1 && a.taskCalls === aTaskToolUses && aTotalToolUses > aTaskToolUses;
  log(`\n[gate 1] WITH a Task tool_use (mixed with a Read)`);
  log(`  actions: ${aActions.length} total tool_use=${aTotalToolUses} (Task=${aTaskToolUses})`);
  log(`  detectDelegation -> delegated=${a.delegated} taskCalls=${a.taskCalls}`);
  log(
    `  ${gate1 ? "PASS" : "FAIL"} — delegated=true, taskCalls==1==count(Task), and a non-Task tool_use is ALSO present (proves this isn't "any tool use")`,
  );

  // Gate 2: WITHOUT Task/Agent (only Read/Bash/Write) -> delegated=false, taskCalls=0.
  const bActions = extractActionLog(normalizeTurns(caseDirect()));
  const bTotalToolUses = bActions.filter((x) => x.kind === "tool_use").length;
  const b = detectDelegation(bActions);
  const gate2 = b.delegated === false && b.taskCalls === 0 && bTotalToolUses >= 3;
  log(`\n[gate 2] WITHOUT Task/Agent (Read + Bash + Write only)`);
  log(`  actions: ${bActions.length} total tool_use=${bTotalToolUses}`);
  log(`  detectDelegation -> delegated=${b.delegated} taskCalls=${b.taskCalls}`);
  log(`  ${gate2 ? "PASS" : "FAIL"} — ordinary direct tool use never false-positives as delegation`);

  // Gate 3 (bonus): the "Agent" tool name must ALSO count (spec: "also count
  // Agent if it ever appears").
  const cActions = extractActionLog(normalizeTurns(caseAgentName()));
  const c = detectDelegation(cActions);
  const gate3 = c.delegated === true && c.taskCalls === 1;
  log(`\n[gate 3, bonus] WITH an "Agent"-named tool_use (no "Task")`);
  log(`  detectDelegation -> delegated=${c.delegated} taskCalls=${c.taskCalls}`);
  log(`  ${gate3 ? "PASS" : "FAIL"} — the "Agent" tool name is also counted`);

  // Gate 4 (bonus): empty action log -> delegated=false, taskCalls=0 (pure
  // boundary check, no pipeline needed).
  const d = detectDelegation([]);
  const gate4 = d.delegated === false && d.taskCalls === 0;
  log(`\n[gate 4, bonus] empty action log`);
  log(`  detectDelegation -> delegated=${d.delegated} taskCalls=${d.taskCalls}`);
  log(`  ${gate4 ? "PASS" : "FAIL"} — no actions at all is never mis-scored delegated`);

  const pass = gate1 && gate2 && gate3 && gate4;
  log("");
  log(`PROVE-DELEGATION VERDICT: ${pass ? "PASS (all four gates)" : "FAIL — see gate(s) above"}`);
  process.exit(pass ? 0 : 1);
}

main();
