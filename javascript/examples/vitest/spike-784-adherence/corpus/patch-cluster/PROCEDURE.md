---
id: patch-cluster
kind: procedure
keywords: [patch, cluster, controlled, safety, runbook]
links: [escalate-ticket, restore-file, restore-record, warm-cache]
status: active
---
# Patch Cluster

## Purpose
This procedure describes how to apply a corrective change to cluster with minimal disruption. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around cluster:
- The node pool
- The capacity plan
- The placement rules
- The drain policy

## Procedure
1. Obtain the approved patch for cluster.
2. Apply it to the metrics pipeline.
3. Re-run the saturation level.
4. Record the patch level in the node pool.

## Verification
Confirm the saturation level is within its expected bound and that the capacity plan reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the metrics pipeline rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the placement rules from the recovery point identified in the preconditions, reattach cluster to the node pool, and confirm the saturation level returns to baseline. Never leave cluster in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond cluster, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `restore-file`
- `restore-record`
- `warm-cache`

## Notes and edge cases
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
A reviewer checking the result afterwards is expected to verify the saturation level independently rather than trusting a single reading. The change owner should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The on-call responder should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards is expected to verify the saturation level independently rather than trusting a single reading. The change owner should confirm the placement rules reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the scheduler actually accepted the change and now reflects it. The change owner must not disable a check to make progress, because a failing check is information. The on-call responder must record what was observed against the operation id so the history stays reconstructable.

The change owner must not disable a check to make progress, because a failing check is information. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The on-call responder should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards needs to confirm that the node pool actually accepted the change and now reflects it. The on-call responder should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should prefer stopping over guessing whenever the scheduler returns an ambiguous response. The operator running this procedure should prefer stopping over guessing whenever the node pool returns an ambiguous response. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the placement rules reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The on-call responder must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the node pool reflects the intended state before treating the step as complete. The person who signs off the operation is expected to verify the saturation level independently rather than trusting a single reading. The person who signs off the operation should leave a clear note for the next person about what remains and why. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.
