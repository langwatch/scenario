---
id: warm-cache
kind: procedure
keywords: [warm, cache, reversible, controlled, audited]
links: [escalate-ticket, snapshot-cache, restore-credential, validate-release]
status: active
---
# Warm Cache

## Purpose
This procedure describes how to prime cache so first requests are fast. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around cache:
- The cache keys
- The eviction policy
- The warm set
- The hit ratio

## Procedure
1. Identify the hot set for cache.
2. Prime the origin store.
3. Confirm the staleness bound.
4. Record the cache keys.

## Verification
Confirm the staleness bound is within its expected bound and that the warm set reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the origin store rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the warm set from the recovery point identified in the preconditions, reattach cache to the cache tier, and confirm the staleness bound returns to baseline. Never leave cache in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond cache, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `snapshot-cache`
- `restore-credential`
- `validate-release`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.

## Additional considerations
The operator running this procedure should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards is expected to verify the staleness bound independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the staleness bound independently rather than trusting a single reading. A reviewer checking the result afterwards needs to confirm that the origin store actually accepted the change and now reflects it.

The change owner is expected to verify the staleness bound independently rather than trusting a single reading. Anyone continuing this work in a follow-up session needs to confirm that the cache tier actually accepted the change and now reflects it. The person who signs off the operation is expected to verify the staleness bound independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the staleness bound independently rather than trusting a single reading. The on-call responder must not disable a check to make progress, because a failing check is information.

The operator running this procedure is expected to verify the staleness bound independently rather than trusting a single reading. The on-call responder should prefer stopping over guessing whenever the invalidation channel returns an ambiguous response. The change owner is expected to verify the staleness bound independently rather than trusting a single reading. The change owner needs to confirm that the origin store actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why.

The operator running this procedure is expected to verify the staleness bound independently rather than trusting a single reading. The change owner needs to confirm that the invalidation channel actually accepted the change and now reflects it. The on-call responder is expected to verify the staleness bound independently rather than trusting a single reading. The person who signs off the operation should prefer stopping over guessing whenever the origin store returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information.

The person who signs off the operation needs to confirm that the origin store actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information. The operator running this procedure needs to confirm that the invalidation channel actually accepted the change and now reflects it. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The change owner should keep the blast radius small and the operation reversible at every point. The operator running this procedure should prefer stopping over guessing whenever the cache tier returns an ambiguous response.
