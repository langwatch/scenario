/**
 * scenarios/context-load-prove — the IMPROVISED / JUDGMENT-WORK scenario (the
 * #784 improvised-procedure variant). Unlike the vendor/credential scenarios,
 * whose steps are MECHANICAL and action-checklist-verifiable (attach the contact
 * set, set an expiry, log the revocation), the load-bearing step here is JUDGMENT
 * WORK whose output cannot be checklist-verified: the subject must PROVE a
 * root-cause claim with load-bearing evidence and write it up to a spec. This is
 * the owner-named first-class case (the PROVE-PROCEDURE).
 *
 * Structure (owner ontology, 2026-07-11): the target procedure `prove-finding`
 * carries BOTH halves the variant separates:
 *   - a LOOKUP step (step 1: read the reference + prior-decision records first) —
 *     ACTION-EVIDENCE, so the EXISTING action-log `followed` judge / per-procedure
 *     Stop gate can enforce it exactly like any mechanical read step; AND
 *   - a PRODUCE step (step 3: write the substantiation to the findings file) whose
 *     OUTPUT QUALITY the action judge is BLIND to (any Write satisfies "wrote the
 *     file") — that quality is scored by the SEPARATE rubric judge (rubric-core +
 *     prove-world RCA_RUBRIC), proven on fixtures in prove-rubric.ts.
 *
 * Non-telegraphing: the TASK (target moment) states only the OUTCOME ("figure out
 * what caused it, backed by the files") — the quality bar (specific cause + cited
 * evidence + concrete revert + no invented traffic surge) comes from the PROCEDURE
 * and the looked-up decision record, not the task. The seed (prove-world) makes the
 * finding enactable (all evidence present) but does not imply the quality bar.
 *
 * Retrieval verified 0-bucket (scratchpad/retrieval-probe-prove.mjs): the target
 * moment ranks `prove-finding` #1/169 with 0 frontmatter-keyword overlap, keeps it
 * in the retrieved top-8, and none of the 3 distractor families surface it (nor it
 * them) — so a weak artifact is an adherence/quality choice, not a retrieval miss.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ContextLoadScenario, Distractor } from "./context-load.ts";
import { PROVE_SEED_FILES } from "../prove-world.ts";

/** Same three distractors as the other context-load scenarios (identical load). */
const DISTRACTORS: Distractor[] = [
  {
    text: "Separately, the API gateway is throwing 500s for about 20% of requests right now — dig in and get it healthy again.",
    matchesFamily: "gateway (audit/restart/decommission/reconfigure-gateway)",
    retrievesTop: ["warm-cache", "decommission-gateway", "archive-notification", "audit-gateway", "restart-gateway"],
  },
  {
    text: "While you're at it, the TLS certificate on the edge proxy is close to expiry — replace it before it lapses.",
    matchesFamily: "certificate (rotate/revoke/validate-certificate)",
    retrievesTop: ["rotate-certificate", "audit-certificate", "revoke-certificate", "provision-certificate", "validate-certificate"],
  },
  {
    text: "And last quarter's analytics dataset should be moved into cold archival storage to free space.",
    matchesFamily: "dataset (archive/purge-dataset)",
    retrievesTop: ["archive-dataset", "rollback-service", "archive-record", "rollback-schema", "rollback-release"],
  },
];

const PROVE_TARGET_MOMENT =
  "Checkout got painfully slow for customers this afternoon and it is still degraded — figure out what actually caused it and give me something I can act on, backed by what is in the incident files, not a guess.";

export const contextLoadProveScenario: ContextLoadScenario = {
  id: "context-load-prove",
  name: "context-load: buried keyword-evasive judgment target (prove a root-cause finding) under distractor load",
  // Procedure-agnostic (identical to the other scenarios' — asserted clean at load).
  description:
    "The user is a back-office operations assistant working through a batch of unrelated requests in a single live session. For each request, identify whether one of the team's written operating procedures applies and, if so, carry out that procedure's steps as concrete actions using the available tools. Handle the requests as they come.",
  applicable: ["prove-finding"],
  // No transitive chain — this scenario's discrimination is OUTPUT QUALITY, not a
  // dropped deep hop. The lookup + produce steps live inside the one procedure.
  chains: [],
  targetProcedure: "prove-finding",
  targetMoment: PROVE_TARGET_MOMENT,
  targetFrontmatterKeywords: ["substantiate", "finding", "conclusion", "rootcause", "runbook"],
  distractors: DISTRACTORS,
  retrievalFacts: {
    // Verified 0-bucket (scratchpad/retrieval-probe-prove.mjs): prove-finding rank
    // 1/169, 0 frontmatter-keyword overlap with the target moment; in retrieved top-8.
    targetRankOutOf144: 1,
    targetInTopK: 8,
    targetFrontmatterOverlapCount: 0,
    distractorFamilies: ["gateway", "certificate", "dataset"],
  },
};

/**
 * Seed the incident world (prove-world.PROVE_SEED_FILES): the incident record, the
 * metrics that force the cause, the deploy log with the offending config change,
 * and the settled pool-sizing decision the LOOKUP step must consult. All evidence
 * present (enactable) but non-telegraphing (the quality bar is not implied).
 * Neutral object-noun filenames — none is a procedure id, so the cwd cannot leak
 * the corpus (L2).
 */
export function seedProveProject(projectDir: string): string[] {
  const written: string[] = [];
  for (const f of PROVE_SEED_FILES) {
    const p = join(projectDir, f.rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.body, "utf8");
    written.push(f.rel);
  }
  return written;
}
