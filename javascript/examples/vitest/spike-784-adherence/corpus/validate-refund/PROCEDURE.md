---
id: validate-refund
kind: procedure
keywords: [validate, refund, audited, controlled, runbook]
links: [escalate-ticket, review-ticket, reconcile-invoice, validate-release]
status: active
---
# Validate Refund

## Purpose
This procedure describes how to check that refund meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around refund:
- The refund request
- The original charge
- The refund amount
- The reason code

## Procedure
1. Load refund from the case queue.
2. Run the checks against the refund amount.
3. Confirm the refund state.
4. Record the outcome.

## Verification
Confirm the refund state is within its expected bound and that the reason code reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the case queue rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the refund amount from the recovery point identified in the preconditions, reattach refund to the case queue, and confirm the refund state returns to baseline. Never leave refund in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond refund, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `review-ticket`
- `reconcile-invoice`
- `validate-release`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.

## Additional considerations
The operator running this procedure should confirm the refund amount reflects the intended state before treating the step as complete. The operator running this procedure should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should prefer stopping over guessing whenever the case queue returns an ambiguous response. Anyone continuing this work in a follow-up session is expected to verify the refund state independently rather than trusting a single reading.

A reviewer checking the result afterwards needs to confirm that the ledger actually accepted the change and now reflects it. The on-call responder should prefer stopping over guessing whenever the payment processor returns an ambiguous response. The change owner is expected to verify the refund state independently rather than trusting a single reading. A reviewer checking the result afterwards should confirm the reason code reflects the intended state before treating the step as complete. The on-call responder should prefer stopping over guessing whenever the case queue returns an ambiguous response.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the payment processor returns an ambiguous response. The person who signs off the operation is expected to verify the refund state independently rather than trusting a single reading. The change owner must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session needs to confirm that the case queue actually accepted the change and now reflects it. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

The operator running this procedure must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should confirm the refund request reflects the intended state before treating the step as complete. The on-call responder must not disable a check to make progress, because a failing check is information. The change owner should confirm the refund request reflects the intended state before treating the step as complete. The person who signs off the operation should prefer stopping over guessing whenever the case queue returns an ambiguous response.

Anyone continuing this work in a follow-up session needs to confirm that the ledger actually accepted the change and now reflects it. The change owner needs to confirm that the case queue actually accepted the change and now reflects it. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later is expected to verify the refund state independently rather than trusting a single reading.

The operator running this procedure should confirm the refund amount reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder should prefer stopping over guessing whenever the case queue returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards needs to confirm that the payment processor actually accepted the change and now reflects it.
