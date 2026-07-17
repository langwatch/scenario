---
id: drain-cluster
kind: procedure
keywords: [drain, cluster, procedure, safety, recovery]
links: [escalate-ticket, migrate-datastore, validate-release, review-vendor]
status: active
---
# Drain Cluster

## Purpose
This procedure describes how to gracefully remove work from cluster before maintenance. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around cluster:
- The node pool
- The capacity plan
- The placement rules
- The drain policy

## Procedure
1. Stop new work reaching cluster.
2. Let in-flight work on the scheduler complete.
3. Watch the saturation level reach zero.
4. Confirm the drain policy.

## Verification
Confirm the saturation level is within its expected bound and that the capacity plan reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the node pool rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the placement rules from the recovery point identified in the preconditions, reattach cluster to the metrics pipeline, and confirm the saturation level returns to baseline. Never leave cluster in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond cluster, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `migrate-datastore`
- `validate-release`
- `review-vendor`

## Notes and edge cases
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
The operator running this procedure needs to confirm that the metrics pipeline actually accepted the change and now reflects it. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The change owner needs to confirm that the scheduler actually accepted the change and now reflects it. The change owner must record what was observed against the operation id so the history stays reconstructable.

An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The change owner is expected to verify the saturation level independently rather than trusting a single reading. The person who signs off the operation should prefer stopping over guessing whenever the scheduler returns an ambiguous response. The change owner is expected to verify the saturation level independently rather than trusting a single reading. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.

A reviewer checking the result afterwards should prefer stopping over guessing whenever the node pool returns an ambiguous response. The on-call responder needs to confirm that the node pool actually accepted the change and now reflects it. The on-call responder needs to confirm that the scheduler actually accepted the change and now reflects it. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable.

The change owner is expected to verify the saturation level independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should confirm the capacity plan reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The operator running this procedure should prefer stopping over guessing whenever the node pool returns an ambiguous response.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation needs to confirm that the node pool actually accepted the change and now reflects it. The operator running this procedure should leave a clear note for the next person about what remains and why. The change owner needs to confirm that the node pool actually accepted the change and now reflects it. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later is expected to verify the saturation level independently rather than trusting a single reading. The person who signs off the operation should confirm the node pool reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the scheduler actually accepted the change and now reflects it. The operator running this procedure should confirm the placement rules reflects the intended state before treating the step as complete. The person who signs off the operation should leave a clear note for the next person about what remains and why.
