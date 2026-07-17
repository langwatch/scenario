---
id: reconcile-dataset
kind: procedure
keywords: [reconcile, dataset, controlled, runbook, operation]
links: [escalate-ticket, patch-gateway, publish-dataset, patch-schema]
status: active
---
# Reconcile Dataset

## Purpose
This procedure describes how to bring dataset into agreement with the source of truth. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around dataset:
- The dataset snapshot
- The schema descriptor
- The row count
- The lineage record

## Procedure
1. Gather dataset from the pipeline.
2. Compare against the dataset snapshot.
3. Resolve each discrepancy.
4. Confirm the freshness marker.

## Verification
Confirm the freshness marker is within its expected bound and that the lineage record reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the catalog rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the dataset snapshot from the recovery point identified in the preconditions, reattach dataset to the pipeline, and confirm the freshness marker returns to baseline. Never leave dataset in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond dataset, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `patch-gateway`
- `publish-dataset`
- `patch-schema`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Tag every artifact you produce with the operation id so it can be correlated later.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
The person who signs off the operation should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards is expected to verify the freshness marker independently rather than trusting a single reading. A reviewer checking the result afterwards should confirm the dataset snapshot reflects the intended state before treating the step as complete. The operator running this procedure is expected to verify the freshness marker independently rather than trusting a single reading. The operator running this procedure needs to confirm that the datastore actually accepted the change and now reflects it.

The change owner should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session is expected to verify the freshness marker independently rather than trusting a single reading. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session is expected to verify the freshness marker independently rather than trusting a single reading.

An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point.

The operator running this procedure should prefer stopping over guessing whenever the datastore returns an ambiguous response. The change owner should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the catalog returns an ambiguous response. The person who signs off the operation should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The on-call responder needs to confirm that the pipeline actually accepted the change and now reflects it. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The change owner is expected to verify the freshness marker independently rather than trusting a single reading. The change owner must record what was observed against the operation id so the history stays reconstructable.

The change owner should confirm the row count reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The person who signs off the operation should prefer stopping over guessing whenever the pipeline returns an ambiguous response. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point.
