---
id: decommission-queue
kind: procedure
keywords: [decommission, queue, controlled, reversible, recovery]
links: [escalate-ticket, audit-cluster, archive-file, snapshot-cache]
status: active
---
# Decommission Queue

## Purpose
This procedure describes how to retire queue and reclaim its resources cleanly. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around queue:
- The message backlog
- The visibility timeout
- The dead-letter target
- The consumer group

## Procedure
1. Confirm queue carries no live traffic.
2. Detach queue from the broker.
3. Archive the dead-letter target.
4. Record the retirement.

## Verification
Confirm the backlog depth is within its expected bound and that the dead-letter target reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the metrics pipeline rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the consumer group from the recovery point identified in the preconditions, reattach queue to the broker, and confirm the backlog depth returns to baseline. Never leave queue in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond queue, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-cluster`
- `archive-file`
- `snapshot-cache`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The change owner must not disable a check to make progress, because a failing check is information. The change owner should confirm the message backlog reflects the intended state before treating the step as complete. The change owner should confirm the visibility timeout reflects the intended state before treating the step as complete. The change owner must not disable a check to make progress, because a failing check is information.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the broker returns an ambiguous response. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The change owner must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point.

The operator running this procedure should confirm the consumer group reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the consumers actually accepted the change and now reflects it. A reviewer checking the result afterwards is expected to verify the backlog depth independently rather than trusting a single reading. The person who signs off the operation must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards needs to confirm that the consumers actually accepted the change and now reflects it.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session needs to confirm that the metrics pipeline actually accepted the change and now reflects it. The change owner should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response.

The on-call responder must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should leave a clear note for the next person about what remains and why. The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The change owner should confirm the visibility timeout reflects the intended state before treating the step as complete.
