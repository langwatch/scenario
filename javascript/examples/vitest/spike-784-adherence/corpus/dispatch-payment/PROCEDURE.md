---
id: dispatch-payment
kind: procedure
keywords: [dispatch, payment, runbook, recovery, safety]
links: [escalate-ticket, restore-credential, archive-file, snapshot-schema]
status: active
---
# Dispatch Payment

## Purpose
This procedure describes how to send payment to its recipients reliably. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around payment:
- The payment intent
- The authorization code
- The amount
- The settlement record

## Procedure
1. Assemble payment from the payment intent.
2. Hand it to the fraud check.
3. Confirm the capture status.
4. Record delivery.

## Verification
Confirm the capture status is within its expected bound and that the payment intent reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the ledger rather than a cached copy.

## Failure modes
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the settlement record from the recovery point identified in the preconditions, reattach payment to the payment processor, and confirm the capture status returns to baseline. Never leave payment in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond payment, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `restore-credential`
- `archive-file`
- `snapshot-schema`

## Notes and edge cases
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
The change owner must not disable a check to make progress, because a failing check is information. The change owner must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner needs to confirm that the payment processor actually accepted the change and now reflects it. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The on-call responder is expected to verify the capture status independently rather than trusting a single reading. An auditor reconstructing the timeline later needs to confirm that the ledger actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the fraud check returns an ambiguous response. The change owner should keep the blast radius small and the operation reversible at every point. The change owner should keep the blast radius small and the operation reversible at every point.

The on-call responder should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point.

An auditor reconstructing the timeline later is expected to verify the capture status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the capture status independently rather than trusting a single reading. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the capture status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the amount reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session should confirm the payment intent reflects the intended state before treating the step as complete. The on-call responder should confirm the amount reflects the intended state before treating the step as complete. A reviewer checking the result afterwards needs to confirm that the payment processor actually accepted the change and now reflects it. The on-call responder should prefer stopping over guessing whenever the ledger returns an ambiguous response. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.
