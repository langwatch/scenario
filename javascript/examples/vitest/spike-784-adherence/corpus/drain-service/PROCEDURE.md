---
id: drain-service
kind: procedure
keywords: [drain, service, audited, controlled, operation]
links: [escalate-ticket, replicate-record, reconfigure-cache, restore-datastore]
status: active
---
# Drain Service

## Purpose
This procedure describes how to gracefully remove work from service before maintenance. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Stop new work reaching service.
2. Let in-flight work on the orchestration layer complete.
3. Watch the readiness probe reach zero.
4. Confirm the health endpoint.

## Verification
Confirm the readiness probe is within its expected bound and that the deployment manifest reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the orchestration layer rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the health endpoint from the recovery point identified in the preconditions, reattach service to the release registry, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `replicate-record`
- `reconfigure-cache`
- `restore-datastore`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.

## Additional considerations
The person who signs off the operation needs to confirm that the release registry actually accepted the change and now reflects it. The on-call responder should confirm the version tag reflects the intended state before treating the step as complete. The person who signs off the operation is expected to verify the readiness probe independently rather than trusting a single reading. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

The on-call responder should leave a clear note for the next person about what remains and why. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder should confirm the health endpoint reflects the intended state before treating the step as complete. The on-call responder should confirm the health endpoint reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards is expected to verify the readiness probe independently rather than trusting a single reading. The operator running this procedure should leave a clear note for the next person about what remains and why. The on-call responder must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The change owner needs to confirm that the release registry actually accepted the change and now reflects it. The person who signs off the operation should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should confirm the deployment manifest reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading.

The person who signs off the operation needs to confirm that the orchestration layer actually accepted the change and now reflects it. The on-call responder should prefer stopping over guessing whenever the load balancer returns an ambiguous response. The on-call responder must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards needs to confirm that the load balancer actually accepted the change and now reflects it.
