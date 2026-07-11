---
id: restart-service
kind: procedure
keywords: [restart, service, runbook, procedure, recovery]
links: [escalate-ticket, snapshot-schema, archive-release, validate-payment]
status: active
---
# Restart Service

## Purpose
This procedure describes how to cycle service to clear transient faults without data loss. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Drain in-flight work from service.
2. Cycle the release registry.
3. Wait for the readiness probe.
4. Verify the rollout config is intact.

## Verification
Confirm the readiness probe is within its expected bound and that the deployment manifest reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the load balancer rather than a cached copy.

## Failure modes
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the rollout config from the recovery point identified in the preconditions, reattach service to the orchestration layer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `snapshot-schema`
- `archive-release`
- `validate-payment`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.

## Additional considerations
The person who signs off the operation is expected to verify the readiness probe independently rather than trusting a single reading. The change owner should prefer stopping over guessing whenever the release registry returns an ambiguous response. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response. Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading. The person who signs off the operation is expected to verify the readiness probe independently rather than trusting a single reading.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The on-call responder needs to confirm that the orchestration layer actually accepted the change and now reflects it. The change owner should prefer stopping over guessing whenever the load balancer returns an ambiguous response. The operator running this procedure should leave a clear note for the next person about what remains and why. The on-call responder should prefer stopping over guessing whenever the load balancer returns an ambiguous response.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading. The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the health endpoint reflects the intended state before treating the step as complete. The on-call responder should confirm the rollout config reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards is expected to verify the readiness probe independently rather than trusting a single reading. An auditor reconstructing the timeline later should confirm the deployment manifest reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the load balancer returns an ambiguous response.

Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading. A reviewer checking the result afterwards is expected to verify the readiness probe independently rather than trusting a single reading. The operator running this procedure should prefer stopping over guessing whenever the release registry returns an ambiguous response. Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading.

A reviewer checking the result afterwards needs to confirm that the load balancer actually accepted the change and now reflects it. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The on-call responder should prefer stopping over guessing whenever the load balancer returns an ambiguous response. The operator running this procedure needs to confirm that the release registry actually accepted the change and now reflects it. The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading.
