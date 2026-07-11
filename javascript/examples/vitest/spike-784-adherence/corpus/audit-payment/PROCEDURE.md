---
id: audit-payment
kind: procedure
keywords: [audit, payment, runbook, safety, procedure]
links: [escalate-ticket, restore-file, replicate-datastore, throttle-gateway]
status: active
---
# Audit Payment

## Purpose
This procedure describes how to review payment against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around payment:
- The payment intent
- The authorization code
- The amount
- The settlement record

## Procedure
1. Enumerate payment in the payment processor.
2. Compare each against policy.
3. Record deviations in the settlement record.
4. Confirm the capture status.

## Verification
Confirm the capture status is within its expected bound and that the amount reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the ledger rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the settlement record from the recovery point identified in the preconditions, reattach payment to the payment processor, and confirm the capture status returns to baseline. Never leave payment in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond payment, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `restore-file`
- `replicate-datastore`
- `throttle-gateway`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.

## Additional considerations
The on-call responder should leave a clear note for the next person about what remains and why. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the fraud check returns an ambiguous response. The person who signs off the operation should confirm the settlement record reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards needs to confirm that the ledger actually accepted the change and now reflects it. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should confirm the settlement record reflects the intended state before treating the step as complete.

The change owner must not disable a check to make progress, because a failing check is information. The change owner must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the fraud check returns an ambiguous response. The change owner should leave a clear note for the next person about what remains and why. The change owner should leave a clear note for the next person about what remains and why.

The change owner should prefer stopping over guessing whenever the fraud check returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the capture status independently rather than trusting a single reading. The on-call responder should leave a clear note for the next person about what remains and why. The operator running this procedure should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should confirm the payment intent reflects the intended state before treating the step as complete.

The change owner must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should confirm the payment intent reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later needs to confirm that the payment processor actually accepted the change and now reflects it. A reviewer checking the result afterwards should confirm the amount reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the ledger returns an ambiguous response.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should confirm the payment intent reflects the intended state before treating the step as complete. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should confirm the settlement record reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.
