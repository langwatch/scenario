---
id: migrate-dataset
kind: procedure
keywords: [migrate, dataset, procedure, safety, recovery]
links: [escalate-ticket, validate-invoice, audit-account, purge-report]
status: active
---
# Migrate Dataset

## Purpose
This procedure describes how to move dataset to a new format or location without loss. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around dataset:
- The dataset snapshot
- The schema descriptor
- The row count
- The lineage record

## Procedure
1. Prepare the migration for dataset.
2. Apply it to the datastore.
3. Verify the freshness marker.
4. Reconcile the row count.

## Verification
Confirm the freshness marker is within its expected bound and that the schema descriptor reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the catalog rather than a cached copy.

## Failure modes
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the lineage record from the recovery point identified in the preconditions, reattach dataset to the datastore, and confirm the freshness marker returns to baseline. Never leave dataset in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond dataset, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-invoice`
- `audit-account`
- `purge-report`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.

## Additional considerations
Anyone continuing this work in a follow-up session is expected to verify the freshness marker independently rather than trusting a single reading. The person who signs off the operation should prefer stopping over guessing whenever the catalog returns an ambiguous response. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The on-call responder should prefer stopping over guessing whenever the catalog returns an ambiguous response. Anyone continuing this work in a follow-up session needs to confirm that the pipeline actually accepted the change and now reflects it.

The change owner must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session is expected to verify the freshness marker independently rather than trusting a single reading. The on-call responder should leave a clear note for the next person about what remains and why. The change owner is expected to verify the freshness marker independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the catalog returns an ambiguous response.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the pipeline returns an ambiguous response. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should leave a clear note for the next person about what remains and why. The operator running this procedure should prefer stopping over guessing whenever the pipeline returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information.

The change owner is expected to verify the freshness marker independently rather than trusting a single reading. The on-call responder should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should confirm the dataset snapshot reflects the intended state before treating the step as complete.

The person who signs off the operation should confirm the schema descriptor reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the freshness marker independently rather than trusting a single reading. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information.

A reviewer checking the result afterwards is expected to verify the freshness marker independently rather than trusting a single reading. The on-call responder must not disable a check to make progress, because a failing check is information. The change owner is expected to verify the freshness marker independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the freshness marker independently rather than trusting a single reading. The change owner should prefer stopping over guessing whenever the catalog returns an ambiguous response.
