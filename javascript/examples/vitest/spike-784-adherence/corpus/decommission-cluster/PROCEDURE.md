---
id: decommission-cluster
kind: procedure
keywords: [decommission, cluster, recovery, procedure, runbook]
links: [escalate-ticket, revoke-credential, handle-refund, archive-payment]
status: active
---
# Decommission Cluster

## Purpose
This procedure describes how to retire cluster and reclaim its resources cleanly. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around cluster:
- The node pool
- The capacity plan
- The placement rules
- The drain policy

## Procedure
1. Confirm cluster carries no live traffic.
2. Detach cluster from the metrics pipeline.
3. Archive the capacity plan.
4. Record the retirement.

## Verification
Confirm the saturation level is within its expected bound and that the placement rules reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the scheduler rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the node pool from the recovery point identified in the preconditions, reattach cluster to the scheduler, and confirm the saturation level returns to baseline. Never leave cluster in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond cluster, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `revoke-credential`
- `handle-refund`
- `archive-payment`

## Notes and edge cases
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
An auditor reconstructing the timeline later is expected to verify the saturation level independently rather than trusting a single reading. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the node pool returns an ambiguous response. The on-call responder needs to confirm that the metrics pipeline actually accepted the change and now reflects it. The on-call responder should confirm the drain policy reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder should prefer stopping over guessing whenever the node pool returns an ambiguous response. The person who signs off the operation should prefer stopping over guessing whenever the node pool returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information. The person who signs off the operation needs to confirm that the scheduler actually accepted the change and now reflects it.

An auditor reconstructing the timeline later should prefer stopping over guessing whenever the node pool returns an ambiguous response. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. A reviewer checking the result afterwards should confirm the capacity plan reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder is expected to verify the saturation level independently rather than trusting a single reading.

An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The change owner must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session is expected to verify the saturation level independently rather than trusting a single reading.

The operator running this procedure needs to confirm that the metrics pipeline actually accepted the change and now reflects it. The change owner is expected to verify the saturation level independently rather than trusting a single reading. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards is expected to verify the saturation level independently rather than trusting a single reading. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable.

The change owner should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should confirm the capacity plan reflects the intended state before treating the step as complete. The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the scheduler returns an ambiguous response.
