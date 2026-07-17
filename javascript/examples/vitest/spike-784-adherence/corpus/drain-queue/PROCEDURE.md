---
id: drain-queue
kind: procedure
keywords: [drain, queue, runbook, safety, controlled]
links: [escalate-ticket, snapshot-dataset, patch-gateway, audit-vendor]
status: active
---
# Drain Queue

## Purpose
This procedure describes how to gracefully remove work from queue before maintenance. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around queue:
- The message backlog
- The visibility timeout
- The dead-letter target
- The consumer group

## Procedure
1. Stop new work reaching queue.
2. Let in-flight work on the consumers complete.
3. Watch the backlog depth reach zero.
4. Confirm the message backlog.

## Verification
Confirm the backlog depth is within its expected bound and that the dead-letter target reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the broker rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the dead-letter target from the recovery point identified in the preconditions, reattach queue to the consumers, and confirm the backlog depth returns to baseline. Never leave queue in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond queue, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `snapshot-dataset`
- `patch-gateway`
- `audit-vendor`

## Notes and edge cases
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Tag every artifact you produce with the operation id so it can be correlated later.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
The change owner should confirm the visibility timeout reflects the intended state before treating the step as complete. The change owner is expected to verify the backlog depth independently rather than trusting a single reading. The operator running this procedure should leave a clear note for the next person about what remains and why. The person who signs off the operation should leave a clear note for the next person about what remains and why. The change owner is expected to verify the backlog depth independently rather than trusting a single reading.

The operator running this procedure needs to confirm that the broker actually accepted the change and now reflects it. A reviewer checking the result afterwards should confirm the consumer group reflects the intended state before treating the step as complete. The change owner needs to confirm that the broker actually accepted the change and now reflects it. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should prefer stopping over guessing whenever the broker returns an ambiguous response.

The operator running this procedure must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. The operator running this procedure must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards needs to confirm that the metrics pipeline actually accepted the change and now reflects it. The on-call responder must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information.

An auditor reconstructing the timeline later is expected to verify the backlog depth independently rather than trusting a single reading. The operator running this procedure should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later is expected to verify the backlog depth independently rather than trusting a single reading. The operator running this procedure should prefer stopping over guessing whenever the consumers returns an ambiguous response. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point.

The on-call responder should confirm the consumer group reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards is expected to verify the backlog depth independently rather than trusting a single reading. The on-call responder must not disable a check to make progress, because a failing check is information. The operator running this procedure is expected to verify the backlog depth independently rather than trusting a single reading.
