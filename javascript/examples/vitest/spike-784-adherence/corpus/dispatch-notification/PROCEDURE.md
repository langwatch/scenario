---
id: dispatch-notification
kind: procedure
keywords: [dispatch, notification, recovery, controlled, safety]
links: [escalate-ticket, scale-datastore, validate-file, snapshot-cluster]
status: active
---
# Dispatch Notification

## Purpose
This procedure describes how to send notification to its recipients reliably. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around notification:
- The message template
- The recipient list
- The delivery window
- The throttle budget

## Procedure
1. Assemble notification from the delivery window.
2. Hand it to the bounce log.
3. Confirm the delivery receipt.
4. Record delivery.

## Verification
Confirm the delivery receipt is within its expected bound and that the delivery window reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the delivery gateway rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the throttle budget from the recovery point identified in the preconditions, reattach notification to the delivery gateway, and confirm the delivery receipt returns to baseline. Never leave notification in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond notification, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `scale-datastore`
- `validate-file`
- `snapshot-cluster`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.

## Additional considerations
The on-call responder is expected to verify the delivery receipt independently rather than trusting a single reading. The operator running this procedure should prefer stopping over guessing whenever the bounce log returns an ambiguous response. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should confirm the delivery window reflects the intended state before treating the step as complete.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation is expected to verify the delivery receipt independently rather than trusting a single reading. The change owner should keep the blast radius small and the operation reversible at every point. The change owner should prefer stopping over guessing whenever the bounce log returns an ambiguous response.

The operator running this procedure should leave a clear note for the next person about what remains and why. The on-call responder should confirm the throttle budget reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards is expected to verify the delivery receipt independently rather than trusting a single reading.

The change owner should confirm the message template reflects the intended state before treating the step as complete. The change owner needs to confirm that the bounce log actually accepted the change and now reflects it. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

The on-call responder is expected to verify the delivery receipt independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the delivery gateway returns an ambiguous response. The operator running this procedure is expected to verify the delivery receipt independently rather than trusting a single reading. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session needs to confirm that the bounce log actually accepted the change and now reflects it.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder must not disable a check to make progress, because a failing check is information. The operator running this procedure must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session needs to confirm that the bounce log actually accepted the change and now reflects it. The change owner should leave a clear note for the next person about what remains and why.
