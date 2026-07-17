---
id: restore-datastore
kind: procedure
keywords: [restore, datastore, audited, safety, recovery]
links: [escalate-ticket, dispatch-invoice, archive-invoice, patch-datastore]
status: active
---
# Restore Datastore

## Purpose
This procedure describes how to recover datastore from a known-good copy. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around datastore:
- The snapshot
- The replication lag
- The schema
- The backup catalog

## Procedure
1. Select the recovery point for datastore.
2. Restore the backup catalog into the primary.
3. Verify the consistency check.
4. Reconcile any gap.

## Verification
Confirm the consistency check is within its expected bound and that the schema reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the primary rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the snapshot from the recovery point identified in the preconditions, reattach datastore to the replica set, and confirm the consistency check returns to baseline. Never leave datastore in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond datastore, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `dispatch-invoice`
- `archive-invoice`
- `patch-datastore`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.

## Additional considerations
The operator running this procedure should confirm the snapshot reflects the intended state before treating the step as complete. The person who signs off the operation is expected to verify the consistency check independently rather than trusting a single reading. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The change owner is expected to verify the consistency check independently rather than trusting a single reading. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable.

The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the replica set returns an ambiguous response. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The change owner should prefer stopping over guessing whenever the backup vault returns an ambiguous response. The on-call responder should prefer stopping over guessing whenever the replica set returns an ambiguous response. The person who signs off the operation is expected to verify the consistency check independently rather than trusting a single reading. The person who signs off the operation should confirm the schema reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session is expected to verify the consistency check independently rather than trusting a single reading. The operator running this procedure is expected to verify the consistency check independently rather than trusting a single reading. The on-call responder needs to confirm that the replica set actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session is expected to verify the consistency check independently rather than trusting a single reading. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the backup vault returns an ambiguous response.

Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should confirm the backup catalog reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session needs to confirm that the primary actually accepted the change and now reflects it. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

The on-call responder should confirm the backup catalog reflects the intended state before treating the step as complete. The on-call responder is expected to verify the consistency check independently rather than trusting a single reading. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should prefer stopping over guessing whenever the replica set returns an ambiguous response.
