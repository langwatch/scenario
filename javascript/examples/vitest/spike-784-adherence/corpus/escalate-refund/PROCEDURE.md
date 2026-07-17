---
id: escalate-refund
kind: procedure
keywords: [escalate, refund, safety, runbook, operation]
links: [escalate-ticket, audit-certificate, patch-schema, revoke-access]
status: active
---
# Escalate Refund

## Purpose
This procedure describes how to route refund to the right responder without delay. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around refund:
- The refund request
- The original charge
- The refund amount
- The reason code

## Procedure
1. Classify the severity of refund.
2. Assign an owner in the ledger.
3. Notify via the original charge.
4. Confirm the refund state.

## Verification
Confirm the refund state is within its expected bound and that the original charge reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the ledger rather than a cached copy.

## Failure modes
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the refund request from the recovery point identified in the preconditions, reattach refund to the ledger, and confirm the refund state returns to baseline. Never leave refund in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond refund, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-certificate`
- `patch-schema`
- `revoke-access`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
A reviewer checking the result afterwards needs to confirm that the payment processor actually accepted the change and now reflects it. The change owner must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the ledger returns an ambiguous response. The person who signs off the operation should prefer stopping over guessing whenever the case queue returns an ambiguous response. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The person who signs off the operation should prefer stopping over guessing whenever the payment processor returns an ambiguous response. An auditor reconstructing the timeline later should confirm the refund amount reflects the intended state before treating the step as complete.

The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards is expected to verify the refund state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the ledger returns an ambiguous response. The person who signs off the operation should prefer stopping over guessing whenever the ledger returns an ambiguous response. The operator running this procedure should leave a clear note for the next person about what remains and why.

The person who signs off the operation should prefer stopping over guessing whenever the payment processor returns an ambiguous response. Anyone continuing this work in a follow-up session is expected to verify the refund state independently rather than trusting a single reading. A reviewer checking the result afterwards should prefer stopping over guessing whenever the case queue returns an ambiguous response. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards is expected to verify the refund state independently rather than trusting a single reading.

The person who signs off the operation is expected to verify the refund state independently rather than trusting a single reading. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The change owner should prefer stopping over guessing whenever the payment processor returns an ambiguous response. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

An auditor reconstructing the timeline later needs to confirm that the payment processor actually accepted the change and now reflects it. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards is expected to verify the refund state independently rather than trusting a single reading. The on-call responder must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why.
