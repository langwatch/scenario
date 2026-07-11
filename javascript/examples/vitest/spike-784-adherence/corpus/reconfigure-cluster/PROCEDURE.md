---
id: reconfigure-cluster
kind: procedure
keywords: [reconfigure, cluster, reversible, runbook, recovery]
links: [escalate-ticket, drain-cluster, audit-vendor, reconcile-ticket]
status: active
---
# Reconfigure Cluster

## Purpose
This procedure describes how to change the configuration of cluster in a controlled way. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around cluster:
- The node pool
- The capacity plan
- The placement rules
- The drain policy

## Procedure
1. Capture the current configuration of cluster.
2. Apply the new settings to the metrics pipeline.
3. Validate against the saturation level.
4. Persist the placement rules.

## Verification
Confirm the saturation level is within its expected bound and that the capacity plan reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the node pool rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the node pool from the recovery point identified in the preconditions, reattach cluster to the node pool, and confirm the saturation level returns to baseline. Never leave cluster in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond cluster, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `drain-cluster`
- `audit-vendor`
- `reconcile-ticket`

## Notes and edge cases
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
An auditor reconstructing the timeline later should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the drain policy reflects the intended state before treating the step as complete. The on-call responder is expected to verify the saturation level independently rather than trusting a single reading. The on-call responder is expected to verify the saturation level independently rather than trusting a single reading.

A reviewer checking the result afterwards should confirm the node pool reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the node pool returns an ambiguous response. The on-call responder should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response.

The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure needs to confirm that the scheduler actually accepted the change and now reflects it. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The person who signs off the operation is expected to verify the saturation level independently rather than trusting a single reading. The operator running this procedure should keep the blast radius small and the operation reversible at every point.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later needs to confirm that the node pool actually accepted the change and now reflects it. The on-call responder should keep the blast radius small and the operation reversible at every point. The on-call responder should keep the blast radius small and the operation reversible at every point. The operator running this procedure must not disable a check to make progress, because a failing check is information.

The person who signs off the operation needs to confirm that the scheduler actually accepted the change and now reflects it. The operator running this procedure should prefer stopping over guessing whenever the scheduler returns an ambiguous response. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should confirm the drain policy reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response.

The operator running this procedure should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. The operator running this procedure should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. The operator running this procedure needs to confirm that the scheduler actually accepted the change and now reflects it. An auditor reconstructing the timeline later needs to confirm that the scheduler actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session needs to confirm that the metrics pipeline actually accepted the change and now reflects it.
