---
id: archive-dataset
kind: procedure
keywords: [archive, dataset, recovery, operation, procedure]
links: [escalate-ticket, drain-queue, offboard-vendor, purge-dataset]
status: active
---
# Archive Dataset

## Purpose
This procedure describes how to move dataset to long-term storage under its retention rules. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around dataset:
- The dataset snapshot
- The schema descriptor
- The row count
- The lineage record

## Procedure
1. Confirm dataset is eligible for archival.
2. Move the lineage record to the datastore.
3. Verify the freshness marker.
4. Update the index.

## Verification
Confirm the freshness marker is within its expected bound and that the lineage record reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the pipeline rather than a cached copy.

## Failure modes
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the schema descriptor from the recovery point identified in the preconditions, reattach dataset to the datastore, and confirm the freshness marker returns to baseline. Never leave dataset in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond dataset, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `drain-queue`
- `offboard-vendor`
- `purge-dataset`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The operator running this procedure should confirm the row count reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the datastore actually accepted the change and now reflects it. The on-call responder should prefer stopping over guessing whenever the datastore returns an ambiguous response. A reviewer checking the result afterwards should confirm the lineage record reflects the intended state before treating the step as complete.

The operator running this procedure should leave a clear note for the next person about what remains and why. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should prefer stopping over guessing whenever the pipeline returns an ambiguous response. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must not disable a check to make progress, because a failing check is information.

The on-call responder must not disable a check to make progress, because a failing check is information. The person who signs off the operation must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The person who signs off the operation must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The change owner should confirm the lineage record reflects the intended state before treating the step as complete. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The operator running this procedure needs to confirm that the datastore actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session is expected to verify the freshness marker independently rather than trusting a single reading. A reviewer checking the result afterwards should confirm the dataset snapshot reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards needs to confirm that the datastore actually accepted the change and now reflects it. An auditor reconstructing the timeline later should confirm the lineage record reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The change owner should leave a clear note for the next person about what remains and why. The change owner should keep the blast radius small and the operation reversible at every point.

Anyone continuing this work in a follow-up session is expected to verify the freshness marker independently rather than trusting a single reading. The change owner must not disable a check to make progress, because a failing check is information. The change owner should prefer stopping over guessing whenever the catalog returns an ambiguous response. The on-call responder should confirm the dataset snapshot reflects the intended state before treating the step as complete. The on-call responder should prefer stopping over guessing whenever the pipeline returns an ambiguous response.
