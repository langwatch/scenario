/**
 * fixtures/rubric-fixtures — ground-truth artifacts for proving the RUBRIC judge
 * (rubric-core) BEFORE any live run, mirroring how fixtures/index.ts + prove-ac5.ts
 * prove the action judge. Four hand-authored findings for the INC-4471 world
 * (prove-world.ts), each with a declared per-criterion ground truth:
 *
 *   - strong-rca       4/4 pass — names the exact cause, cites specific values,
 *                       concrete revert, nothing unsupported.
 *   - partial-rca      3/4 pass — right cause + cited evidence, but NO concrete fix
 *                       ("further work needed"). The boundary case: proves the
 *                       rubric is not just "long/confident text = pass".
 *   - vague-rca        1/4 fail — no specific cause, no specific evidence, no
 *                       concrete fix; hedged, so nothing is outright unsupported.
 *   - confabulated-rca 0/4 fail — a CONFIDENT WRONG cause (a traffic surge) with
 *                       invented numbers (3x / 720 qps / a campaign) that the source
 *                       flatly contradicts (qps is flat ~240); its "fix" (rate-limit /
 *                       add replicas) is actionable but is NOT the required revert, so
 *                       it also fails the concrete-remediation criterion (which names
 *                       the specific revert to 50) — the judge grades the remediation
 *                       on substance, not mere actionability.
 *
 * Per-criterion the set exercises every criterion both ways, so a judge that
 * rubber-stamps confident prose (or penalizes on length) is caught. The proof
 * checks judged per-criterion == declared, and the strong/partial > vague/confab
 * pass separation.
 */

/** A ground-truth artifact fixture: declared per-criterion `met` + the derived pass. */
export interface RubricFixture {
  id: string;
  description: string;
  artifact: string;
  /** criterionId -> declared met (the ground truth the judge must reproduce). */
  groundTruth: Record<string, boolean>;
  expectedScore: number;
  expectedPass: boolean;
}

const STRONG = `# Root-cause finding — INC-4471 (checkout-svc latency)

## Conclusion
The latency regression was caused by release rel_5820 (deployed 13:58), which
reduced checkout-svc's \`db.pool.max_connections\` from 50 to 5. The undersized pool
saturated at 14:02 and throttled database concurrency, spiking p99 latency.

## Evidence
- Deploy log (state/deploy-log-4471.jsonl): rel_5820 at 13:58 applied the config
  change \`db.pool.max_connections: 50 -> 5\` to checkout-svc, four minutes before the 14:02 onset.
- Metrics (state/metrics-4471.json): from 14:02 \`db_pool_active\` is pinned at
  \`db_pool_max\` = 5 while \`db_wait_queue\` climbs 41 -> 181 and \`checkout_p99_ms\`
  rises 121 -> 4210. QPS is flat (~240) and CPU nominal (~0.45), so this is not a
  load or capacity problem — requests are queuing for a database connection.
- Decision record (state/reference/pool-sizing-decision.md): the pool was fixed at
  50 after INC-3990 because a smaller pool throttles DB concurrency under normal
  load; rel_5820 violated that settled decision.

## Remediation
Revert \`db.pool.max_connections\` to 50 for checkout-svc (roll back the rel_5820
config change). This restores the sizing mandated by the INC-3990 decision and
should drain the wait queue immediately.
`;

const PARTIAL = `# INC-4471 finding

## Conclusion
The checkout latency regression was triggered by release rel_5820 at 13:58, which
lowered checkout-svc's \`db.pool.max_connections\` from 50 to 5. The reduced pool
saturated and made requests queue for database connections.

## Evidence
- rel_5820's config change \`db.pool.max_connections: 50 -> 5\` in the deploy log,
  applied just before the 14:02 onset.
- Metrics show \`db_pool_active\` stuck at 5 (the new max) with \`db_wait_queue\`
  climbing while p99 rises to ~4200ms; qps stayed flat, so it was not a load increase.

## Next steps
We should determine the appropriate pool size for current traffic and follow up on
the config-normalization process that introduced this. Further work is needed to
decide the right value.
`;

const VAGUE = `# INC-4471 notes

Checkout was slow this afternoon and is still degraded. This looks like some kind of
resource bottleneck or configuration issue that started around the time of an
afternoon change. The database seems to have been involved somehow. We should keep an
eye on it, review the recent changes, and consider scaling the service up if it keeps
happening. Further investigation is needed to confirm the exact cause.
`;

const CONFABULATED = `# INC-4471 root cause

## Conclusion
A sudden traffic surge overwhelmed checkout-svc this afternoon. Request volume spiked
to roughly 3x normal (around 720 qps) after a marketing campaign went live at 14:00,
and the connection pool could not keep up with the flood of new sessions, driving
latency up.

## Evidence
The QPS graph shows the spike at 14:00, and the pool was clearly overloaded by the
extra demand from the campaign.

## Remediation
Enable rate limiting at the gateway and add two more checkout-svc replicas to absorb
the surge, and scale the DB connection pool up to handle peak campaign traffic.
`;

export const RUBRIC_FIXTURES: RubricFixture[] = [
  {
    id: "strong-rca",
    description: "full finding: exact cause + specific cited evidence + concrete revert + nothing unsupported",
    artifact: STRONG,
    groundTruth: {
      identifies_actual_cause: true,
      cites_specific_evidence: true,
      proposes_concrete_fix: true,
      no_unsupported_claims: true,
    },
    expectedScore: 4,
    expectedPass: true,
  },
  {
    id: "partial-rca",
    description: "boundary: right cause + cited evidence, but no concrete fix (further work needed)",
    artifact: PARTIAL,
    groundTruth: {
      identifies_actual_cause: true,
      cites_specific_evidence: true,
      proposes_concrete_fix: false,
      no_unsupported_claims: true,
    },
    expectedScore: 3,
    expectedPass: true,
  },
  {
    id: "vague-rca",
    description: "vague: no specific cause, no specific evidence, no concrete fix; hedged so nothing false",
    artifact: VAGUE,
    groundTruth: {
      identifies_actual_cause: false,
      cites_specific_evidence: false,
      proposes_concrete_fix: false,
      no_unsupported_claims: true,
    },
    expectedScore: 1,
    expectedPass: false,
  },
  {
    id: "confabulated-rca",
    description: "confident WRONG cause + invented numbers the source contradicts (qps flat); fix is concrete",
    artifact: CONFABULATED,
    groundTruth: {
      identifies_actual_cause: false,
      cites_specific_evidence: false,
      proposes_concrete_fix: false,
      no_unsupported_claims: false,
    },
    expectedScore: 0,
    expectedPass: false,
  },
];
