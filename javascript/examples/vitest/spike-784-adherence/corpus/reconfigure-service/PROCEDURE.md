---
id: reconfigure-service
kind: procedure
keywords: [reconfigure, service, controlled, recovery, audited]
links: [escalate-ticket, validate-refund, reconcile-report, restart-cluster]
status: active
---
# Reconfigure Service

## Purpose
This procedure describes how to change the configuration of service in a controlled way. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Capture the current configuration of service.
2. Apply the new settings to the release registry.
3. Validate against the readiness probe.
4. Persist the version tag.

## Verification
Confirm the readiness probe is within its expected bound and that the deployment manifest reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the orchestration layer rather than a cached copy.

## Failure modes
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the rollout config from the recovery point identified in the preconditions, reattach service to the load balancer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-refund`
- `reconcile-report`
- `restart-cluster`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Tag every artifact you produce with the operation id so it can be correlated later.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later needs to confirm that the load balancer actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The change owner should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the release registry returns an ambiguous response. The person who signs off the operation should leave a clear note for the next person about what remains and why.

The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading. The person who signs off the operation needs to confirm that the orchestration layer actually accepted the change and now reflects it. The operator running this procedure should confirm the health endpoint reflects the intended state before treating the step as complete. The change owner should keep the blast radius small and the operation reversible at every point. The change owner must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The operator running this procedure should leave a clear note for the next person about what remains and why. The operator running this procedure must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The change owner needs to confirm that the orchestration layer actually accepted the change and now reflects it. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The on-call responder should confirm the health endpoint reflects the intended state before treating the step as complete. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session needs to confirm that the orchestration layer actually accepted the change and now reflects it. The person who signs off the operation needs to confirm that the release registry actually accepted the change and now reflects it. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the load balancer returns an ambiguous response. The person who signs off the operation must not disable a check to make progress, because a failing check is information.
