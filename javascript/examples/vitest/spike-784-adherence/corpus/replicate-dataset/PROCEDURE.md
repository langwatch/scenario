---
id: replicate-dataset
kind: procedure
keywords: [replicate, dataset, safety, procedure, operation]
links: [escalate-ticket, restore-datastore, validate-queue, validate-notification]
status: active
---
# Replicate Dataset

## Purpose
This procedure describes how to create and verify a redundant copy of dataset. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around dataset:
- The dataset snapshot
- The schema descriptor
- The row count
- The lineage record

## Procedure
1. Select the replication target for dataset.
2. Copy the dataset snapshot to the pipeline.
3. Verify the freshness marker.
4. Record the replica.

## Verification
Confirm the freshness marker is within its expected bound and that the schema descriptor reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the pipeline rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the schema descriptor from the recovery point identified in the preconditions, reattach dataset to the pipeline, and confirm the freshness marker returns to baseline. Never leave dataset in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond dataset, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `restore-datastore`
- `validate-queue`
- `validate-notification`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.

## Additional considerations
A reviewer checking the result afterwards needs to confirm that the catalog actually accepted the change and now reflects it. The change owner should confirm the row count reflects the intended state before treating the step as complete. The operator running this procedure should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The on-call responder should leave a clear note for the next person about what remains and why.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. The person who signs off the operation is expected to verify the freshness marker independently rather than trusting a single reading. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The change owner should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should confirm the schema descriptor reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder must not disable a check to make progress, because a failing check is information. The on-call responder must not disable a check to make progress, because a failing check is information.

The operator running this procedure needs to confirm that the pipeline actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The on-call responder should confirm the schema descriptor reflects the intended state before treating the step as complete. The change owner needs to confirm that the datastore actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why.

The person who signs off the operation is expected to verify the freshness marker independently rather than trusting a single reading. The person who signs off the operation should prefer stopping over guessing whenever the datastore returns an ambiguous response. A reviewer checking the result afterwards needs to confirm that the datastore actually accepted the change and now reflects it. The on-call responder is expected to verify the freshness marker independently rather than trusting a single reading. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards needs to confirm that the pipeline actually accepted the change and now reflects it. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should prefer stopping over guessing whenever the pipeline returns an ambiguous response. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.
