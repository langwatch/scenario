---
id: purge-file
kind: procedure
keywords: [purge, file, reversible, operation, runbook]
links: [escalate-ticket, archive-vendor, audit-certificate, replicate-record]
status: active
---
# Purge File

## Purpose
This procedure describes how to permanently remove file once it is no longer needed. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around file:
- The file contents
- The checksum
- The quarantine label
- The retention flag

## Procedure
1. Confirm file is past its retention.
2. Remove it from the object store.
3. Confirm the scan verdict.
4. Record the deletion in the retention flag.

## Verification
Confirm the scan verdict is within its expected bound and that the quarantine label reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the object store rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the checksum from the recovery point identified in the preconditions, reattach file to the archive tier, and confirm the scan verdict returns to baseline. Never leave file in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond file, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-vendor`
- `audit-certificate`
- `replicate-record`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
A reviewer checking the result afterwards needs to confirm that the scanning service actually accepted the change and now reflects it. A reviewer checking the result afterwards should confirm the retention flag reflects the intended state before treating the step as complete. The change owner needs to confirm that the object store actually accepted the change and now reflects it. The change owner needs to confirm that the object store actually accepted the change and now reflects it. The person who signs off the operation should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the scanning service returns an ambiguous response. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should confirm the retention flag reflects the intended state before treating the step as complete. The change owner should confirm the file contents reflects the intended state before treating the step as complete. The on-call responder should keep the blast radius small and the operation reversible at every point.

An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The on-call responder should confirm the file contents reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The on-call responder should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later needs to confirm that the archive tier actually accepted the change and now reflects it. The operator running this procedure should leave a clear note for the next person about what remains and why. The operator running this procedure should prefer stopping over guessing whenever the archive tier returns an ambiguous response.

The on-call responder needs to confirm that the scanning service actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The operator running this procedure is expected to verify the scan verdict independently rather than trusting a single reading. The change owner must record what was observed against the operation id so the history stays reconstructable.
