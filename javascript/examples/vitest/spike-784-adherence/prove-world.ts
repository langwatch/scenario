/**
 * prove-world — the ground-truth "world" for the improvised/rubric variant's
 * canonical case: the PROVE-PROCEDURE (owner-named first-class test — "prove a
 * claim with load-bearing evidence"). Framework-free (node-only): ONE source of
 * truth reused by (a) the live scenario seed (`seedProveProject`), (b) the live
 * rubric judge's source-material context, and (c) the rubric fixture-proof
 * (`prove-rubric.ts`) — so the rubric is proven on the SAME evidence world the
 * live run scores against.
 *
 * The incident (checkout latency, INC-4471): a 13:58 deploy (rel_5820) reduced
 * checkout-svc's DB pool `max_connections` 50 -> 5, saturating the pool at 14:02
 * (active pinned at 5/5, wait-queue climbing) and spiking p99 latency, while QPS
 * stayed flat (so it is NOT a traffic surge). The change also VIOLATED a settled
 * pool-sizing decision (fixed at 50 after INC-3990). The evidence FORCES one cause;
 * a strong finding names it, cites the specific values, notes the violated decision,
 * and gives a concrete revert. The TASK states only the OUTCOME ("figure out what
 * caused it, backed by the files") — the quality bar (specific cause + cited
 * evidence + concrete fix + no invented traffic surge) comes from the PROCEDURE, not
 * the task (non-telegraphing).
 */

import type { RubricSpec } from "./rubric-core.ts";

export const PROVE_INCIDENT_ID = "INC-4471";
/** Deterministic artifact path the procedure names + the runner reads. Neutral (no procedure id). */
export const PROVE_ARTIFACT_REL = "state/analysis-4471.md";

/** One seeded file: its project-relative path + body. */
export interface SeedFile {
  rel: string;
  body: string;
}

const INCIDENT = JSON.stringify(
  {
    incident_id: "INC-4471",
    service: "checkout-svc",
    symptom: "p99 request latency jumped from ~120ms to ~4200ms and is still degraded",
    onset: "2026-07-11T14:02:00Z",
    error_rate: "normal (~0.2%, unchanged)",
    reported_by: "on-call",
    finding_path: "state/analysis-4471.md",
    note: "Write the substantiated root-cause finding to finding_path.",
  },
  null,
  2,
) + "\n";

// Metrics: the DB pool saturates exactly at onset; QPS is FLAT (rules out a surge);
// CPU/mem normal. pool_max drops 50 -> 5 at 14:02 and active pins at the new max.
const METRICS = JSON.stringify(
  {
    incident_id: "INC-4471",
    service: "checkout-svc",
    window: "2026-07-11T13:50Z..14:10Z",
    series: [
      { t: "13:55", checkout_p99_ms: 118, db_pool_max: 50, db_pool_active: 11, db_wait_queue: 0, qps: 240, cpu: 0.41 },
      { t: "14:00", checkout_p99_ms: 121, db_pool_max: 50, db_pool_active: 13, db_wait_queue: 0, qps: 244, cpu: 0.43 },
      { t: "14:02", checkout_p99_ms: 1450, db_pool_max: 5, db_pool_active: 5, db_wait_queue: 41, qps: 242, cpu: 0.44 },
      { t: "14:05", checkout_p99_ms: 3980, db_pool_max: 5, db_pool_active: 5, db_wait_queue: 152, qps: 239, cpu: 0.45 },
      { t: "14:10", checkout_p99_ms: 4210, db_pool_max: 5, db_pool_active: 5, db_wait_queue: 181, qps: 243, cpu: 0.46 },
    ],
    note: "db_pool_active pinned at db_pool_max (5) from 14:02; db_wait_queue climbing; qps flat across the window; cpu and memory nominal.",
  },
  null,
  2,
) + "\n";

const DEPLOY_LOG =
  [
    JSON.stringify({ release: "rel_5818", at: "2026-07-11T12:10:00Z", service: "checkout-svc", author: "m.ito", note: "email template copy tweak", config_changes: [] }),
    JSON.stringify({
      release: "rel_5820",
      at: "2026-07-11T13:58:00Z",
      service: "checkout-svc",
      author: "config-bot",
      note: "batch config normalization",
      config_changes: [
        { key: "db.pool.max_connections", from: 50, to: 5 },
        { key: "log.sample_rate", from: 0.1, to: 0.1 },
      ],
    }),
    JSON.stringify({ release: "rel_5821", at: "2026-07-11T14:20:00Z", service: "payments-svc", author: "s.roy", note: "retry backoff tuning", config_changes: [{ key: "retry.max", from: 3, to: 4 }] }),
  ].join("\n") + "\n";

const POOL_DECISION = `# Decision record — checkout-svc DB pool sizing

status: settled
decided: 2026-02-19
supersedes: none
do-not-re-litigate: true

## Decision
checkout-svc \`db.pool.max_connections\` is fixed at **50**. It was raised from 10 to 50
after incident INC-3990 (the Feb saturation incident), where a small connection pool
throttled database concurrency under normal load and spiked checkout latency.

## Constraint
Do NOT reduce \`db.pool.max_connections\` below 50 for checkout-svc without a new,
explicit decision that supersedes this one. A smaller pool re-introduces the INC-3990
failure mode.

## Rationale
At normal checkout volume (~240 qps) the service needs ~12 concurrent DB connections
steady-state with headroom for bursts; 50 was chosen to keep the wait queue empty.
`;

/** The seeded files that make the finding enactable (all evidence present + the decision to look up). */
export const PROVE_SEED_FILES: SeedFile[] = [
  { rel: "state/incident-4471.json", body: INCIDENT },
  { rel: "state/metrics-4471.json", body: METRICS },
  { rel: "state/deploy-log-4471.jsonl", body: DEPLOY_LOG },
  { rel: "state/reference/pool-sizing-decision.md", body: POOL_DECISION },
];

/**
 * The SOURCE MATERIAL string the rubric judge checks claims against (the evidence
 * the author had). Concatenation of the seeded evidence with clear headers — the
 * SAME material for the live rubric scoring and the fixture proof.
 */
export function proveSourceMaterial(): string {
  return PROVE_SEED_FILES.map((f) => `===== ${f.rel} =====\n${f.body.trim()}`).join("\n\n");
}

/**
 * The rubric for a substantiated root-cause finding. Four binary criteria; pass
 * threshold 3 of 4. Each criterion is OUTPUT-QUALITY (not action presence) — this is
 * exactly what the action-log `followed` judge cannot see.
 */
export const RCA_RUBRIC: RubricSpec = {
  id: "rca-finding-v1",
  artifactKind: "root-cause finding",
  passThreshold: 3,
  criteria: [
    {
      id: "identifies_actual_cause",
      description:
        "Names the specific cause the evidence forces: the reduction of checkout-svc db.pool.max_connections from 50 to 5 in the 13:58 deploy (rel_5820). A vague cause ('overload', 'a config problem') or a wrong cause (a traffic surge, insufficient capacity) does NOT meet this.",
    },
    {
      id: "cites_specific_evidence",
      description:
        "Ties its load-bearing claims to specific evidence from the source material: e.g. the config change value (max_connections 50 -> 5) in the deploy log, and/or the pool saturation in the metrics (db_pool_active pinned at the new max of 5 with db_wait_queue climbing from 14:02). A general gesture at 'the logs' or 'the metrics' without the specific referent does NOT meet this.",
    },
    {
      id: "proposes_concrete_fix",
      description:
        "Gives a concrete remediation the reader can act on now: revert db.pool.max_connections to 50 (roll back the rel_5820 config change). 'Investigate further', 'keep monitoring', or 'consider scaling' does NOT meet this.",
    },
    {
      id: "no_unsupported_claims",
      description:
        "States no FABRICATED OBSERVATION — no fact about what happened that the source material does not contain. It does NOT invent a traffic surge or QPS increase (qps is flat ~240 across the window), fabricate numbers, or invent an event such as a marketing campaign. This criterion targets fabricated observations ONLY: do NOT penalize causal inferences that follow from the cited evidence (e.g. 'the small pool throttled DB concurrency') or a remediation's expected effect (e.g. 'reverting should clear the wait queue') — those are the analysis, not fabrication. Met unless the artifact asserts an observation the source contradicts or does not contain.",
    },
  ],
};
