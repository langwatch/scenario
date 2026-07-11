---
id: validate-payment
kind: procedure
keywords: [validate, payment, safety, audited, runbook]
links: [escalate-ticket, archive-policy, drain-queue, replicate-service]
status: active
---
# Validate Payment

## Purpose
This procedure describes how to check that payment meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around payment:
- The payment intent
- The authorization code
- The amount
- The settlement record

## Procedure
1. Load payment from the payment processor.
2. Run the checks against the payment intent.
3. Confirm the capture status.
4. Record the outcome.

## Verification
Confirm the capture status is within its expected bound and that the authorization code reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the payment processor rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the amount from the recovery point identified in the preconditions, reattach payment to the ledger, and confirm the capture status returns to baseline. Never leave payment in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond payment, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-policy`
- `drain-queue`
- `replicate-service`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.

## Additional considerations
The change owner must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The on-call responder must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session needs to confirm that the ledger actually accepted the change and now reflects it. The change owner should confirm the settlement record reflects the intended state before treating the step as complete. The change owner needs to confirm that the ledger actually accepted the change and now reflects it. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The operator running this procedure is expected to verify the capture status independently rather than trusting a single reading.

The person who signs off the operation should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The on-call responder needs to confirm that the fraud check actually accepted the change and now reflects it. A reviewer checking the result afterwards is expected to verify the capture status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information.

A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder is expected to verify the capture status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the ledger returns an ambiguous response. The change owner needs to confirm that the fraud check actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the payment processor returns an ambiguous response. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should prefer stopping over guessing whenever the fraud check returns an ambiguous response. The on-call responder should prefer stopping over guessing whenever the fraud check returns an ambiguous response.

The operator running this procedure must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later is expected to verify the capture status independently rather than trusting a single reading. The on-call responder must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.
