---
id: snapshot-cluster
kind: procedure
keywords: [snapshot, cluster, safety, recovery, runbook]
links: [escalate-ticket, patch-gateway, dispatch-report, audit-certificate]
status: active
---
# Snapshot Cluster

## Purpose
This procedure describes how to capture a consistent point-in-time copy of cluster. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around cluster:
- The node pool
- The capacity plan
- The placement rules
- The drain policy

## Procedure
1. Quiesce writes to cluster.
2. Capture the capacity plan.
3. Verify the snapshot against the saturation level.
4. Register it in the node pool.

## Verification
Confirm the saturation level is within its expected bound and that the node pool reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the node pool rather than a cached copy.

## Failure modes
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the capacity plan from the recovery point identified in the preconditions, reattach cluster to the scheduler, and confirm the saturation level returns to baseline. Never leave cluster in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond cluster, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `patch-gateway`
- `dispatch-report`
- `audit-certificate`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.

## Additional considerations
Anyone continuing this work in a follow-up session should confirm the drain policy reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the scheduler returns an ambiguous response.

The on-call responder needs to confirm that the scheduler actually accepted the change and now reflects it. An auditor reconstructing the timeline later needs to confirm that the scheduler actually accepted the change and now reflects it. The on-call responder should keep the blast radius small and the operation reversible at every point. The on-call responder is expected to verify the saturation level independently rather than trusting a single reading. A reviewer checking the result afterwards is expected to verify the saturation level independently rather than trusting a single reading.

A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The change owner must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The change owner must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should confirm the capacity plan reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards needs to confirm that the scheduler actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session needs to confirm that the metrics pipeline actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The operator running this procedure should confirm the node pool reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point.

The operator running this procedure should confirm the capacity plan reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session needs to confirm that the metrics pipeline actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why.
