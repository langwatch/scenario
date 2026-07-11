---
id: archive-file
kind: procedure
keywords: [archive, file, procedure, safety, runbook]
links: [escalate-ticket, decommission-queue, decommission-endpoint, validate-invoice]
status: active
---
# Archive File

## Purpose
This procedure describes how to move file to long-term storage under its retention rules. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around file:
- The file contents
- The checksum
- The quarantine label
- The retention flag

## Procedure
1. Confirm file is eligible for archival.
2. Move the quarantine label to the archive tier.
3. Verify the scan verdict.
4. Update the index.

## Verification
Confirm the scan verdict is within its expected bound and that the retention flag reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the object store rather than a cached copy.

## Failure modes
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the file contents from the recovery point identified in the preconditions, reattach file to the scanning service, and confirm the scan verdict returns to baseline. Never leave file in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond file, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `decommission-queue`
- `decommission-endpoint`
- `validate-invoice`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.

## Additional considerations
The change owner should confirm the checksum reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should confirm the file contents reflects the intended state before treating the step as complete. The on-call responder should prefer stopping over guessing whenever the archive tier returns an ambiguous response. The change owner should confirm the checksum reflects the intended state before treating the step as complete.

The on-call responder should keep the blast radius small and the operation reversible at every point. The operator running this procedure must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the quarantine label reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the scanning service returns an ambiguous response. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.

A reviewer checking the result afterwards should confirm the checksum reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder is expected to verify the scan verdict independently rather than trusting a single reading. An auditor reconstructing the timeline later should confirm the checksum reflects the intended state before treating the step as complete. The operator running this procedure is expected to verify the scan verdict independently rather than trusting a single reading.

The on-call responder should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards is expected to verify the scan verdict independently rather than trusting a single reading. An auditor reconstructing the timeline later is expected to verify the scan verdict independently rather than trusting a single reading. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The change owner should prefer stopping over guessing whenever the object store returns an ambiguous response.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the scanning service returns an ambiguous response. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The on-call responder should keep the blast radius small and the operation reversible at every point.

The change owner must not disable a check to make progress, because a failing check is information. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should prefer stopping over guessing whenever the object store returns an ambiguous response. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the retention flag reflects the intended state before treating the step as complete.
