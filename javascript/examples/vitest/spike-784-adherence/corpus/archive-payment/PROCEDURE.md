---
id: archive-payment
kind: procedure
keywords: [archive, payment, safety, operation, runbook]
links: [escalate-ticket, rollback-schema, rotate-certificate, scale-cluster]
status: active
---
# Archive Payment

## Purpose
This procedure describes how to move payment to long-term storage under its retention rules. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around payment:
- The payment intent
- The authorization code
- The amount
- The settlement record

## Procedure
1. Confirm payment is eligible for archival.
2. Move the settlement record to the payment processor.
3. Verify the capture status.
4. Update the index.

## Verification
Confirm the capture status is within its expected bound and that the payment intent reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the fraud check rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the settlement record from the recovery point identified in the preconditions, reattach payment to the payment processor, and confirm the capture status returns to baseline. Never leave payment in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond payment, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `rollback-schema`
- `rotate-certificate`
- `scale-cluster`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
The operator running this procedure is expected to verify the capture status independently rather than trusting a single reading. The on-call responder should leave a clear note for the next person about what remains and why. The operator running this procedure must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The person who signs off the operation is expected to verify the capture status independently rather than trusting a single reading.

A reviewer checking the result afterwards is expected to verify the capture status independently rather than trusting a single reading. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the capture status independently rather than trusting a single reading. The on-call responder must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why.

The operator running this procedure should prefer stopping over guessing whenever the fraud check returns an ambiguous response. Anyone continuing this work in a follow-up session is expected to verify the capture status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the payment processor returns an ambiguous response. The change owner should prefer stopping over guessing whenever the ledger returns an ambiguous response.

A reviewer checking the result afterwards should prefer stopping over guessing whenever the payment processor returns an ambiguous response. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the ledger returns an ambiguous response. The person who signs off the operation is expected to verify the capture status independently rather than trusting a single reading. A reviewer checking the result afterwards should prefer stopping over guessing whenever the ledger returns an ambiguous response. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information.

The person who signs off the operation is expected to verify the capture status independently rather than trusting a single reading. The person who signs off the operation must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The change owner should confirm the amount reflects the intended state before treating the step as complete.

An auditor reconstructing the timeline later should confirm the settlement record reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the fraud check returns an ambiguous response. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later is expected to verify the capture status independently rather than trusting a single reading.
