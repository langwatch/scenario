---
id: reconcile-datastore
kind: procedure
keywords: [reconcile, datastore, runbook, recovery, safety]
links: [escalate-ticket, validate-release, validate-gateway, validate-record]
status: active
---
# Reconcile Datastore

## Purpose
This procedure describes how to bring datastore into agreement with the source of truth. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around datastore:
- The snapshot
- The replication lag
- The schema
- The backup catalog

## Procedure
1. Gather datastore from the primary.
2. Compare against the backup catalog.
3. Resolve each discrepancy.
4. Confirm the consistency check.

## Verification
Confirm the consistency check is within its expected bound and that the schema reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the backup vault rather than a cached copy.

## Failure modes
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the replication lag from the recovery point identified in the preconditions, reattach datastore to the primary, and confirm the consistency check returns to baseline. Never leave datastore in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond datastore, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-release`
- `validate-gateway`
- `validate-record`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.

## Additional considerations
A reviewer checking the result afterwards is expected to verify the consistency check independently rather than trusting a single reading. An auditor reconstructing the timeline later needs to confirm that the replica set actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards is expected to verify the consistency check independently rather than trusting a single reading. The change owner must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The change owner is expected to verify the consistency check independently rather than trusting a single reading. The on-call responder needs to confirm that the primary actually accepted the change and now reflects it. The person who signs off the operation needs to confirm that the replica set actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable.

The person who signs off the operation should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards is expected to verify the consistency check independently rather than trusting a single reading. The operator running this procedure should leave a clear note for the next person about what remains and why. The on-call responder should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the backup vault returns an ambiguous response.

Anyone continuing this work in a follow-up session should confirm the snapshot reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later needs to confirm that the backup vault actually accepted the change and now reflects it. An auditor reconstructing the timeline later should confirm the snapshot reflects the intended state before treating the step as complete. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.

The on-call responder must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should confirm the snapshot reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable.

The change owner should prefer stopping over guessing whenever the replica set returns an ambiguous response. The on-call responder should confirm the schema reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should confirm the backup catalog reflects the intended state before treating the step as complete. The on-call responder should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point.
