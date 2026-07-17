---
id: purge-record
kind: procedure
keywords: [purge, record, audited, recovery, procedure]
links: [escalate-ticket, purge-queue, provision-queue, audit-certificate]
status: active
---
# Purge Record

## Purpose
This procedure describes how to permanently remove record once it is no longer needed. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around record:
- The record body
- The retention label
- The checksum
- The index entry

## Procedure
1. Confirm record is past its retention.
2. Remove it from the archive tier.
3. Confirm the integrity check.
4. Record the deletion in the retention label.

## Verification
Confirm the integrity check is within its expected bound and that the index entry reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the search index rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the record body from the recovery point identified in the preconditions, reattach record to the datastore, and confirm the integrity check returns to baseline. Never leave record in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond record, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `purge-queue`
- `provision-queue`
- `audit-certificate`

## Notes and edge cases
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The on-call responder needs to confirm that the search index actually accepted the change and now reflects it. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The change owner should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the archive tier returns an ambiguous response.

The person who signs off the operation should prefer stopping over guessing whenever the search index returns an ambiguous response. The on-call responder should prefer stopping over guessing whenever the archive tier returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the integrity check independently rather than trusting a single reading. A reviewer checking the result afterwards should confirm the retention label reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should confirm the retention label reflects the intended state before treating the step as complete.

The person who signs off the operation should leave a clear note for the next person about what remains and why. The person who signs off the operation should prefer stopping over guessing whenever the search index returns an ambiguous response. An auditor reconstructing the timeline later is expected to verify the integrity check independently rather than trusting a single reading. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

An auditor reconstructing the timeline later should confirm the retention label reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session is expected to verify the integrity check independently rather than trusting a single reading. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.

A reviewer checking the result afterwards is expected to verify the integrity check independently rather than trusting a single reading. The change owner should prefer stopping over guessing whenever the datastore returns an ambiguous response. The operator running this procedure should prefer stopping over guessing whenever the datastore returns an ambiguous response. The operator running this procedure needs to confirm that the archive tier actually accepted the change and now reflects it. The on-call responder is expected to verify the integrity check independently rather than trusting a single reading.

Anyone continuing this work in a follow-up session needs to confirm that the search index actually accepted the change and now reflects it. The operator running this procedure needs to confirm that the search index actually accepted the change and now reflects it. The change owner needs to confirm that the archive tier actually accepted the change and now reflects it. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The on-call responder should keep the blast radius small and the operation reversible at every point.
