---
id: validate-cluster
kind: procedure
keywords: [validate, cluster, procedure, recovery, controlled]
links: [escalate-ticket, validate-certificate, archive-payment, review-release]
status: active
---
# Validate Cluster

## Purpose
This procedure describes how to check that cluster meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around cluster:
- The node pool
- The capacity plan
- The placement rules
- The drain policy

## Procedure
1. Load cluster from the node pool.
2. Run the checks against the node pool.
3. Confirm the saturation level.
4. Record the outcome.

## Verification
Confirm the saturation level is within its expected bound and that the drain policy reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the node pool rather than a cached copy.

## Failure modes
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the capacity plan from the recovery point identified in the preconditions, reattach cluster to the node pool, and confirm the saturation level returns to baseline. Never leave cluster in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond cluster, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-certificate`
- `archive-payment`
- `review-release`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Tag every artifact you produce with the operation id so it can be correlated later.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
Anyone continuing this work in a follow-up session should confirm the capacity plan reflects the intended state before treating the step as complete. The on-call responder should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the saturation level independently rather than trusting a single reading. The on-call responder should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session is expected to verify the saturation level independently rather than trusting a single reading.

A reviewer checking the result afterwards needs to confirm that the scheduler actually accepted the change and now reflects it. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards needs to confirm that the node pool actually accepted the change and now reflects it. The on-call responder should prefer stopping over guessing whenever the node pool returns an ambiguous response.

The change owner must not disable a check to make progress, because a failing check is information. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should confirm the drain policy reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the node pool returns an ambiguous response.

The change owner should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The on-call responder needs to confirm that the metrics pipeline actually accepted the change and now reflects it. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The on-call responder should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The change owner should prefer stopping over guessing whenever the node pool returns an ambiguous response. The operator running this procedure should prefer stopping over guessing whenever the node pool returns an ambiguous response. The person who signs off the operation should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later is expected to verify the saturation level independently rather than trusting a single reading. A reviewer checking the result afterwards should confirm the drain policy reflects the intended state before treating the step as complete. The operator running this procedure should confirm the placement rules reflects the intended state before treating the step as complete. The person who signs off the operation should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.
