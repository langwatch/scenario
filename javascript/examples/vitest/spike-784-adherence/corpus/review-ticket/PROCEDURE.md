---
id: review-ticket
kind: procedure
keywords: [review, ticket, audited, runbook, safety]
links: [escalate-ticket, throttle-gateway, restart-cluster, archive-notification]
status: active
---
# Review Ticket

## Purpose
This procedure describes how to evaluate ticket and record an explicit decision. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around ticket:
- The ticket summary
- The severity label
- The owner assignment
- The resolution notes

## Procedure
1. Collect ticket and its context from the queue.
2. Assess it against the owner assignment.
3. Record the decision.
4. Confirm the acknowledgement.

## Verification
Confirm the acknowledgement is within its expected bound and that the owner assignment reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the notification channel rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the ticket summary from the recovery point identified in the preconditions, reattach ticket to the on-call rota, and confirm the acknowledgement returns to baseline. Never leave ticket in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond ticket, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `throttle-gateway`
- `restart-cluster`
- `archive-notification`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.

## Additional considerations
The change owner must not disable a check to make progress, because a failing check is information. The on-call responder should prefer stopping over guessing whenever the queue returns an ambiguous response. The operator running this procedure should prefer stopping over guessing whenever the on-call rota returns an ambiguous response. The person who signs off the operation is expected to verify the acknowledgement independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the severity label reflects the intended state before treating the step as complete.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards is expected to verify the acknowledgement independently rather than trusting a single reading. Anyone continuing this work in a follow-up session needs to confirm that the notification channel actually accepted the change and now reflects it. A reviewer checking the result afterwards is expected to verify the acknowledgement independently rather than trusting a single reading. The change owner must record what was observed against the operation id so the history stays reconstructable.

The on-call responder must not disable a check to make progress, because a failing check is information. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure needs to confirm that the queue actually accepted the change and now reflects it. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should prefer stopping over guessing whenever the notification channel returns an ambiguous response.

An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later is expected to verify the acknowledgement independently rather than trusting a single reading. The change owner should prefer stopping over guessing whenever the queue returns an ambiguous response. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The change owner should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards should confirm the resolution notes reflects the intended state before treating the step as complete. The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner must not disable a check to make progress, because a failing check is information. The on-call responder should keep the blast radius small and the operation reversible at every point. The on-call responder should keep the blast radius small and the operation reversible at every point.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. The person who signs off the operation needs to confirm that the notification channel actually accepted the change and now reflects it. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder needs to confirm that the notification channel actually accepted the change and now reflects it. The on-call responder must record what was observed against the operation id so the history stays reconstructable.
