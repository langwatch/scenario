---
id: validate-queue
kind: procedure
keywords: [validate, queue, operation, procedure, runbook]
links: [escalate-ticket, throttle-service, backup-datastore, audit-record]
status: active
---
# Validate Queue

## Purpose
This procedure describes how to check that queue meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around queue:
- The message backlog
- The visibility timeout
- The dead-letter target
- The consumer group

## Procedure
1. Load queue from the consumers.
2. Run the checks against the consumer group.
3. Confirm the backlog depth.
4. Record the outcome.

## Verification
Confirm the backlog depth is within its expected bound and that the dead-letter target reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the broker rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the consumer group from the recovery point identified in the preconditions, reattach queue to the consumers, and confirm the backlog depth returns to baseline. Never leave queue in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond queue, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `throttle-service`
- `backup-datastore`
- `audit-record`

## Notes and edge cases
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.

## Additional considerations
Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point.

A reviewer checking the result afterwards should prefer stopping over guessing whenever the consumers returns an ambiguous response. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation is expected to verify the backlog depth independently rather than trusting a single reading. A reviewer checking the result afterwards is expected to verify the backlog depth independently rather than trusting a single reading.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the dead-letter target reflects the intended state before treating the step as complete. The on-call responder is expected to verify the backlog depth independently rather than trusting a single reading. The person who signs off the operation should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. The person who signs off the operation needs to confirm that the metrics pipeline actually accepted the change and now reflects it.

A reviewer checking the result afterwards should confirm the visibility timeout reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The person who signs off the operation should prefer stopping over guessing whenever the broker returns an ambiguous response. The person who signs off the operation is expected to verify the backlog depth independently rather than trusting a single reading. The change owner should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later needs to confirm that the metrics pipeline actually accepted the change and now reflects it. A reviewer checking the result afterwards is expected to verify the backlog depth independently rather than trusting a single reading. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should prefer stopping over guessing whenever the broker returns an ambiguous response. A reviewer checking the result afterwards should confirm the visibility timeout reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session needs to confirm that the broker actually accepted the change and now reflects it. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session needs to confirm that the broker actually accepted the change and now reflects it. The change owner must record what was observed against the operation id so the history stays reconstructable.
