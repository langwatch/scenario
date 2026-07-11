---
id: drain-gateway
kind: procedure
keywords: [drain, gateway, operation, safety, controlled]
links: [escalate-ticket, snapshot-schema, validate-release, reconfigure-cluster]
status: active
---
# Drain Gateway

## Purpose
This procedure describes how to gracefully remove work from gateway before maintenance. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around gateway:
- The routing rules
- The upstream pool
- The header policy
- The connection limits

## Procedure
1. Stop new work reaching gateway.
2. Let in-flight work on the config store complete.
3. Watch the health signal reach zero.
4. Confirm the connection limits.

## Verification
Confirm the health signal is within its expected bound and that the header policy reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the upstream services rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the upstream pool from the recovery point identified in the preconditions, reattach gateway to the upstream services, and confirm the health signal returns to baseline. Never leave gateway in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond gateway, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `snapshot-schema`
- `validate-release`
- `reconfigure-cluster`

## Notes and edge cases
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards is expected to verify the health signal independently rather than trusting a single reading.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should prefer stopping over guessing whenever the config store returns an ambiguous response.

The change owner should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should prefer stopping over guessing whenever the upstream services returns an ambiguous response. Anyone continuing this work in a follow-up session needs to confirm that the upstream services actually accepted the change and now reflects it. An auditor reconstructing the timeline later needs to confirm that the config store actually accepted the change and now reflects it. The change owner must record what was observed against the operation id so the history stays reconstructable.

The change owner should prefer stopping over guessing whenever the edge tier returns an ambiguous response. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards needs to confirm that the upstream services actually accepted the change and now reflects it. The on-call responder should keep the blast radius small and the operation reversible at every point.

The person who signs off the operation should confirm the header policy reflects the intended state before treating the step as complete. The change owner should leave a clear note for the next person about what remains and why. The change owner should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The on-call responder should keep the blast radius small and the operation reversible at every point.

Anyone continuing this work in a follow-up session is expected to verify the health signal independently rather than trusting a single reading. An auditor reconstructing the timeline later is expected to verify the health signal independently rather than trusting a single reading. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The change owner should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable.
