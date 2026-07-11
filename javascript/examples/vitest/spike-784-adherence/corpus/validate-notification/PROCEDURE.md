---
id: validate-notification
kind: procedure
keywords: [validate, notification, reversible, operation, safety]
links: [escalate-ticket, patch-service, decommission-cluster, validate-refund]
status: active
---
# Validate Notification

## Purpose
This procedure describes how to check that notification meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around notification:
- The message template
- The recipient list
- The delivery window
- The throttle budget

## Procedure
1. Load notification from the bounce log.
2. Run the checks against the throttle budget.
3. Confirm the delivery receipt.
4. Record the outcome.

## Verification
Confirm the delivery receipt is within its expected bound and that the delivery window reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the subscription list rather than a cached copy.

## Failure modes
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the recipient list from the recovery point identified in the preconditions, reattach notification to the delivery gateway, and confirm the delivery receipt returns to baseline. Never leave notification in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond notification, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `patch-service`
- `decommission-cluster`
- `validate-refund`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
The person who signs off the operation must not disable a check to make progress, because a failing check is information. The change owner should prefer stopping over guessing whenever the bounce log returns an ambiguous response. A reviewer checking the result afterwards needs to confirm that the delivery gateway actually accepted the change and now reflects it. The person who signs off the operation needs to confirm that the delivery gateway actually accepted the change and now reflects it. The operator running this procedure must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The change owner should prefer stopping over guessing whenever the delivery gateway returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the delivery receipt independently rather than trusting a single reading. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should prefer stopping over guessing whenever the delivery gateway returns an ambiguous response.

The person who signs off the operation should prefer stopping over guessing whenever the subscription list returns an ambiguous response. The on-call responder should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The change owner must not disable a check to make progress, because a failing check is information.

The change owner should leave a clear note for the next person about what remains and why. The person who signs off the operation is expected to verify the delivery receipt independently rather than trusting a single reading. The on-call responder is expected to verify the delivery receipt independently rather than trusting a single reading. An auditor reconstructing the timeline later needs to confirm that the bounce log actually accepted the change and now reflects it. The person who signs off the operation should confirm the message template reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards needs to confirm that the bounce log actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards is expected to verify the delivery receipt independently rather than trusting a single reading. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The change owner should prefer stopping over guessing whenever the delivery gateway returns an ambiguous response.

A reviewer checking the result afterwards should confirm the message template reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the subscription list actually accepted the change and now reflects it. The operator running this procedure must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should prefer stopping over guessing whenever the subscription list returns an ambiguous response. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.
