---
id: replicate-cluster
kind: procedure
keywords: [replicate, cluster, procedure, safety, recovery]
links: [escalate-ticket, reconfigure-cache, decommission-cluster, reconcile-access]
status: active
---
# Replicate Cluster

## Purpose
This procedure describes how to create and verify a redundant copy of cluster. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around cluster:
- The node pool
- The capacity plan
- The placement rules
- The drain policy

## Procedure
1. Select the replication target for cluster.
2. Copy the drain policy to the node pool.
3. Verify the saturation level.
4. Record the replica.

## Verification
Confirm the saturation level is within its expected bound and that the node pool reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the metrics pipeline rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the capacity plan from the recovery point identified in the preconditions, reattach cluster to the node pool, and confirm the saturation level returns to baseline. Never leave cluster in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond cluster, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `reconfigure-cache`
- `decommission-cluster`
- `reconcile-access`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
Anyone continuing this work in a follow-up session should confirm the drain policy reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should prefer stopping over guessing whenever the scheduler returns an ambiguous response. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The operator running this procedure should prefer stopping over guessing whenever the scheduler returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner is expected to verify the saturation level independently rather than trusting a single reading. The operator running this procedure needs to confirm that the node pool actually accepted the change and now reflects it. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The operator running this procedure should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session is expected to verify the saturation level independently rather than trusting a single reading. The on-call responder is expected to verify the saturation level independently rather than trusting a single reading. The operator running this procedure should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards should prefer stopping over guessing whenever the node pool returns an ambiguous response. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should confirm the node pool reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later is expected to verify the saturation level independently rather than trusting a single reading.

The on-call responder should prefer stopping over guessing whenever the scheduler returns an ambiguous response. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the drain policy reflects the intended state before treating the step as complete. The operator running this procedure must not disable a check to make progress, because a failing check is information. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable.

The on-call responder is expected to verify the saturation level independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the saturation level independently rather than trusting a single reading. The on-call responder must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.
