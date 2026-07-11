---
id: quarantine-file
kind: procedure
keywords: [quarantine, file, runbook, operation, reversible]
links: [escalate-ticket, validate-queue, review-vendor, restart-gateway]
status: active
---
# Quarantine File

## Purpose
This procedure describes how to isolate file suspected of being unsafe. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around file:
- The file contents
- The checksum
- The quarantine label
- The retention flag

## Procedure
1. Move file out of the active path.
2. Isolate it in the archive tier.
3. Flag the quarantine label.
4. Confirm the scan verdict.

## Verification
Confirm the scan verdict is within its expected bound and that the file contents reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the archive tier rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the checksum from the recovery point identified in the preconditions, reattach file to the object store, and confirm the scan verdict returns to baseline. Never leave file in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond file, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-queue`
- `review-vendor`
- `restart-gateway`

## Notes and edge cases
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Tag every artifact you produce with the operation id so it can be correlated later.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.

## Additional considerations
The change owner is expected to verify the scan verdict independently rather than trusting a single reading. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards is expected to verify the scan verdict independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the scan verdict independently rather than trusting a single reading.

A reviewer checking the result afterwards is expected to verify the scan verdict independently rather than trusting a single reading. A reviewer checking the result afterwards should prefer stopping over guessing whenever the scanning service returns an ambiguous response. The change owner should prefer stopping over guessing whenever the object store returns an ambiguous response. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should prefer stopping over guessing whenever the object store returns an ambiguous response.

Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation is expected to verify the scan verdict independently rather than trusting a single reading. An auditor reconstructing the timeline later is expected to verify the scan verdict independently rather than trusting a single reading. The on-call responder must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The on-call responder should prefer stopping over guessing whenever the scanning service returns an ambiguous response. The on-call responder should prefer stopping over guessing whenever the archive tier returns an ambiguous response. The person who signs off the operation is expected to verify the scan verdict independently rather than trusting a single reading. The change owner should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder is expected to verify the scan verdict independently rather than trusting a single reading. An auditor reconstructing the timeline later needs to confirm that the archive tier actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the archive tier returns an ambiguous response.

Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The on-call responder needs to confirm that the object store actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session needs to confirm that the archive tier actually accepted the change and now reflects it. The on-call responder should prefer stopping over guessing whenever the archive tier returns an ambiguous response.
