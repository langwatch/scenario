---
id: purge-queue
kind: procedure
keywords: [purge, queue, runbook, operation, recovery]
links: [escalate-ticket, rollback-schema, restore-account, snapshot-datastore]
status: active
---
# Purge Queue

## Purpose
This procedure describes how to permanently remove queue once it is no longer needed. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around queue:
- The message backlog
- The visibility timeout
- The dead-letter target
- The consumer group

## Procedure
1. Confirm queue is past its retention.
2. Remove it from the broker.
3. Confirm the backlog depth.
4. Record the deletion in the message backlog.

## Verification
Confirm the backlog depth is within its expected bound and that the consumer group reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the consumers rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the visibility timeout from the recovery point identified in the preconditions, reattach queue to the broker, and confirm the backlog depth returns to baseline. Never leave queue in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond queue, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `rollback-schema`
- `restore-account`
- `snapshot-datastore`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
The person who signs off the operation should prefer stopping over guessing whenever the broker returns an ambiguous response. A reviewer checking the result afterwards should prefer stopping over guessing whenever the consumers returns an ambiguous response. The on-call responder must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later needs to confirm that the consumers actually accepted the change and now reflects it. The person who signs off the operation should prefer stopping over guessing whenever the broker returns an ambiguous response.

The change owner should confirm the message backlog reflects the intended state before treating the step as complete. A reviewer checking the result afterwards needs to confirm that the broker actually accepted the change and now reflects it. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The person who signs off the operation is expected to verify the backlog depth independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the message backlog reflects the intended state before treating the step as complete.

The change owner should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should prefer stopping over guessing whenever the consumers returns an ambiguous response. An auditor reconstructing the timeline later is expected to verify the backlog depth independently rather than trusting a single reading.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. A reviewer checking the result afterwards needs to confirm that the broker actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. The operator running this procedure is expected to verify the backlog depth independently rather than trusting a single reading.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The change owner should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the broker returns an ambiguous response. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the broker returns an ambiguous response. The change owner should prefer stopping over guessing whenever the consumers returns an ambiguous response.

An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the broker returns an ambiguous response. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The change owner must record what was observed against the operation id so the history stays reconstructable.
