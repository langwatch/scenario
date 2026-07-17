---
id: throttle-service
kind: procedure
keywords: [throttle, service, operation, runbook, reversible]
links: [escalate-ticket, archive-certificate, drain-service, decommission-cluster]
status: active
---
# Throttle Service

## Purpose
This procedure describes how to limit the rate at which service is served to protect the system. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Measure current pressure on service.
2. Set the limit in the release registry.
3. Watch the readiness probe.
4. Record the applied limit in the health endpoint.

## Verification
Confirm the readiness probe is within its expected bound and that the version tag reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the orchestration layer rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the deployment manifest from the recovery point identified in the preconditions, reattach service to the release registry, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-certificate`
- `drain-service`
- `decommission-cluster`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Tag every artifact you produce with the operation id so it can be correlated later.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading. The operator running this procedure needs to confirm that the load balancer actually accepted the change and now reflects it. The on-call responder should prefer stopping over guessing whenever the release registry returns an ambiguous response. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable.

The operator running this procedure should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading. The on-call responder should keep the blast radius small and the operation reversible at every point.

The person who signs off the operation should leave a clear note for the next person about what remains and why. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The change owner must record what was observed against the operation id so the history stays reconstructable.

The on-call responder should confirm the rollout config reflects the intended state before treating the step as complete. The operator running this procedure must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the deployment manifest reflects the intended state before treating the step as complete.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards needs to confirm that the load balancer actually accepted the change and now reflects it. The change owner should leave a clear note for the next person about what remains and why. The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner needs to confirm that the release registry actually accepted the change and now reflects it.

The operator running this procedure should confirm the deployment manifest reflects the intended state before treating the step as complete. The on-call responder is expected to verify the readiness probe independently rather than trusting a single reading. The change owner should confirm the deployment manifest reflects the intended state before treating the step as complete. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should confirm the health endpoint reflects the intended state before treating the step as complete.
