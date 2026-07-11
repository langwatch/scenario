---
id: rollback-service
kind: procedure
keywords: [rollback, service, controlled, operation, runbook]
links: [escalate-ticket, validate-schema, restore-dataset, reconcile-vendor]
status: active
---
# Roll Back Service

## Purpose
This procedure describes how to revert service to the last known-good state after a failed change. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Identify the last known-good version of service.
2. Halt further promotion.
3. Restore the rollout config.
4. Confirm the readiness probe returns to baseline.

## Verification
Confirm the readiness probe is within its expected bound and that the deployment manifest reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the load balancer rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the health endpoint from the recovery point identified in the preconditions, reattach service to the orchestration layer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-schema`
- `restore-dataset`
- `reconcile-vendor`

## Notes and edge cases
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.

## Additional considerations
An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later needs to confirm that the orchestration layer actually accepted the change and now reflects it. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the release registry returns an ambiguous response.

An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should confirm the version tag reflects the intended state before treating the step as complete. The on-call responder should prefer stopping over guessing whenever the load balancer returns an ambiguous response.

The on-call responder should leave a clear note for the next person about what remains and why. The on-call responder should leave a clear note for the next person about what remains and why. The operator running this procedure needs to confirm that the load balancer actually accepted the change and now reflects it. The change owner needs to confirm that the release registry actually accepted the change and now reflects it. The operator running this procedure should prefer stopping over guessing whenever the load balancer returns an ambiguous response.

The change owner is expected to verify the readiness probe independently rather than trusting a single reading. The change owner is expected to verify the readiness probe independently rather than trusting a single reading. The on-call responder is expected to verify the readiness probe independently rather than trusting a single reading. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The change owner needs to confirm that the release registry actually accepted the change and now reflects it.

The change owner should confirm the rollout config reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable.

The on-call responder should confirm the rollout config reflects the intended state before treating the step as complete. The on-call responder needs to confirm that the load balancer actually accepted the change and now reflects it. A reviewer checking the result afterwards needs to confirm that the release registry actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later needs to confirm that the load balancer actually accepted the change and now reflects it.
