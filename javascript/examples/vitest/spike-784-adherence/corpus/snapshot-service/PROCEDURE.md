---
id: snapshot-service
kind: procedure
keywords: [snapshot, service, runbook, operation, recovery]
links: [escalate-ticket, archive-vendor, validate-cluster, validate-gateway]
status: active
---
# Snapshot Service

## Purpose
This procedure describes how to capture a consistent point-in-time copy of service. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Quiesce writes to service.
2. Capture the health endpoint.
3. Verify the snapshot against the readiness probe.
4. Register it in the load balancer.

## Verification
Confirm the readiness probe is within its expected bound and that the health endpoint reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the release registry rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the health endpoint from the recovery point identified in the preconditions, reattach service to the orchestration layer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-vendor`
- `validate-cluster`
- `validate-gateway`

## Notes and edge cases
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.

## Additional considerations
A reviewer checking the result afterwards is expected to verify the readiness probe independently rather than trusting a single reading. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response. Anyone continuing this work in a follow-up session should confirm the rollout config reflects the intended state before treating the step as complete. The on-call responder needs to confirm that the orchestration layer actually accepted the change and now reflects it. The change owner must not disable a check to make progress, because a failing check is information.

The operator running this procedure needs to confirm that the load balancer actually accepted the change and now reflects it. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the release registry returns an ambiguous response. The person who signs off the operation needs to confirm that the load balancer actually accepted the change and now reflects it. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should confirm the version tag reflects the intended state before treating the step as complete. The person who signs off the operation should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner should keep the blast radius small and the operation reversible at every point. The operator running this procedure should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards needs to confirm that the release registry actually accepted the change and now reflects it. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

An auditor reconstructing the timeline later should confirm the version tag reflects the intended state before treating the step as complete. The person who signs off the operation should prefer stopping over guessing whenever the load balancer returns an ambiguous response. The operator running this procedure should confirm the rollout config reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should confirm the rollout config reflects the intended state before treating the step as complete. The operator running this procedure should keep the blast radius small and the operation reversible at every point.

The change owner should leave a clear note for the next person about what remains and why. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The on-call responder is expected to verify the readiness probe independently rather than trusting a single reading. A reviewer checking the result afterwards should confirm the health endpoint reflects the intended state before treating the step as complete. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable.
