# INC-4471 — Root-cause finding

- **Incident:** INC-4471
- **Service:** checkout-svc
- **Analyzed:** 2026-07-11
- **Status:** root cause identified; remediation is a config rollback (see below)

## Scope of this incident (per the incident files)
What the source files under `state/` actually record:
- Affected service: **checkout-svc** (`incident-4471.json`).
- Symptom: **latency** — `incident-4471.json` reports p99 jumping from ~120 ms to
  ~4200 ms and still degraded; `metrics-4471.json` confirms p99 at 4210 ms by 14:10.
- Error rate: **normal (~0.2%, unchanged)** per `incident-4471.json` — no error/5xx
  regression is recorded in any of the incident files.

This finding is grounded solely in the incident files. The incident telemetry
contains no gateway or error-rate signal, so the analysis proceeds from the recorded
latency incident on checkout-svc. Gateway-level actions (restart / scale / drain the
gateway) would not address this incident, because the cited evidence points to a
persisted DB-pool config value rather than a gateway or transient fault; a restart
would reload the same config value and leave the pool at 5.

## Root cause
Release **rel_5820** (2026-07-11T13:58Z, "batch config normalization", author
`config-bot`) changed `db.pool.max_connections` on checkout-svc from **50 → 5**.
Roughly four minutes later (onset 14:02Z) the DB connection pool saturated and
request latency spiked.

### Evidence
| time  | p99 (ms) | db_pool_max | db_pool_active | db_wait_queue | qps | cpu |
|-------|---------:|------------:|---------------:|--------------:|----:|----:|
| 13:55 |      118 |          50 |             11 |             0 | 240 | .41 |
| 14:00 |      121 |          50 |             13 |             0 | 244 | .43 |
| 14:02 |     1450 |           5 |              5 |            41 | 242 | .44 |
| 14:05 |     3980 |           5 |              5 |           152 | 239 | .45 |
| 14:10 |     4210 |           5 |              5 |           181 | 243 | .46 |

Signature: `db_pool_active` pins exactly at the new `db_pool_max` (5) from 14:02,
`db_wait_queue` climbs monotonically, while **qps (~240) and cpu (~0.45) are flat**.
This is connection-pool starvation, not a load, compute, or traffic problem. The
onset lines up with rel_5820 (13:58Z), and no other checkout-svc change is in the
window (rel_5818 at 12:10 was an email-copy tweak with no config changes; rel_5821
at 14:20 was on payments-svc).

## This is a known, previously-decided failure mode
`state/reference/pool-sizing-decision.md` (settled 2026-02-19, `do-not-re-litigate: true`)
fixes checkout-svc `db.pool.max_connections` at **50** and states that a smaller
pool re-introduces the **INC-3990** saturation incident. rel_5820 violated that
decision. At ~240 qps the service needs ~12 steady-state connections with burst
headroom; 5 is far below the ~13 already observed in use at 14:00.

## Remediation (to restore health)
1. Roll back / override the rel_5820 change: set checkout-svc
   `db.pool.max_connections` back to **50**. Do **not** stop at an intermediate
   value below 50 — the settled decision requires >= 50.
2. After applying, watch `db_wait_queue` drain to 0 and p99 return to the ~120 ms
   baseline; re-check after a short settle period rather than trusting a single
   green reading.
3. Prevent recurrence: exclude `db.pool.max_connections` (and other
   decision-locked keys) from `config-bot`'s "normalization" pass, or gate that
   pass against the pool-sizing decision record so it cannot silently drop a
   protected value.

## Note on scope
The remediation is a config value that this analysis environment does not expose as
an editable live config store (the deploy log is append-only history). The concrete,
substantiated finding and the exact fix are recorded here; applying step 1 requires
the config-store / rollback tooling for checkout-svc.
