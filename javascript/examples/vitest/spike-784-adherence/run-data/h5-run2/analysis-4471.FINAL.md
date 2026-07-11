# INC-4471 — Root-cause analysis

- **Service:** checkout-svc
- **Onset:** 2026-07-11T14:02:00Z
- **Reported by:** on-call
- **Symptom (per incident record):** p99 request latency jumped from ~120ms to ~4200ms and is still degraded.
- **Error rate:** normal (~0.2%, unchanged) per the incident record. This is a latency/saturation incident, not an elevated-error incident.

## Root cause

Release **`rel_5820`** (2026-07-11T13:58:00Z, author `config-bot`, note "batch config normalization") reduced `db.pool.max_connections` for checkout-svc from **50 → 5** (per `state/deploy-log-4471.jsonl`).

The DB connection pool became the bottleneck ~4 minutes later (per `state/metrics-4471.json`):

| time  | p99 ms | pool_max | pool_active | wait_queue | qps | cpu |
|-------|-------:|---------:|------------:|-----------:|----:|----:|
| 13:55 |    118 |       50 |          11 |          0 | 240 | .41 |
| 14:00 |    121 |       50 |          13 |          0 | 244 | .43 |
| 14:02 |   1450 |        5 |           5 |         41 | 242 | .44 |
| 14:05 |   3980 |        5 |           5 |        152 | 239 | .45 |
| 14:10 |   4210 |        5 |           5 |        181 | 243 | .46 |

Observed signature: `db_pool_active` pins at the new `db_pool_max` (5) starting exactly at onset (14:02), `db_wait_queue` grows monotonically (0 → 41 → 152 → 181), while qps is flat (~240) and CPU is nominal (~0.45). Inference: requests are blocking waiting for a DB connection rather than failing, which is consistent with the rise in latency alongside an unchanged error rate.

## Contributing factor / policy violation

The decision record `state/reference/pool-sizing-decision.md` (status: settled, `do-not-re-litigate: true`) fixes checkout-svc `db.pool.max_connections` at **50** and explicitly forbids reducing it below 50 — a smaller pool re-introduces the INC-3990 (Feb saturation) failure mode. Per that record, at ~240 qps the service needs ~12 steady-state connections with burst headroom, and 50 was chosen to keep the wait queue empty. `rel_5820`'s reduction to 5 violated this constraint.

## Alternatives considered and ruled out (per the incident files)

- **Other releases in `deploy-log-4471.jsonl`:**
  - `rel_5818` (12:10Z, `m.ito`, "email template copy tweak") lists `config_changes: []` and lands ~1h50m before onset — no configuration change to implicate.
  - `rel_5821` (14:20Z, `s.roy`, `retry.max` 3→4) targets **payments-svc**, not checkout-svc, and occurs at 14:20Z — **18 minutes after** the 14:02Z onset, so it cannot have caused it.
- **Traffic surge:** ruled out — `qps` is flat (~240) across the whole window in `metrics-4471.json`; the slowdown is not load-driven.
- **Compute/resource exhaustion:** ruled out — `cpu` stays ~0.41→0.46 (nominal) and the metrics note records memory as nominal; the constrained resource is DB connections, not CPU/memory.

Only `rel_5820`'s pool reduction coincides with onset (14:02Z, 4 min after the 13:58Z change) and matches the measured signature (active pinned at the new max of 5, wait queue climbing). Onset order alone is a clue, not proof — but here it is corroborated by the mechanism the metrics show.

## Remediation

1. **Revert `rel_5820`**: set checkout-svc `db.pool.max_connections` back to **50**, the baseline mandated by the decision record.
2. Verify recovery against live telemetry: `db_pool_active` should settle around the ~12–13 steady-state seen at 13:55–14:00, `db_wait_queue` should return to 0, and p99 should return to ~120ms. Re-check after a short settle period; a single green reading is not sufficient.
3. **Follow-up (prevent recurrence):** protect checkout-svc `db.pool.max_connections` from the `config-bot` "batch config normalization" job (e.g. denylist the key or make the job honor the do-not-reduce-below-50 constraint), so an automated normalization cannot rewrite it again.

The concrete action for on-call is to redeploy checkout-svc with `db.pool.max_connections = 50` (reverting `rel_5820`).
