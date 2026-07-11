---
id: patch-service
kind: procedure
keywords: [patch, service, audited, reversible, runbook]
links: [escalate-ticket, decommission-gateway, archive-notification, patch-datastore]
status: active
---
# Patch Service

## Purpose
This procedure describes how to apply a corrective change to service with minimal disruption. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Obtain the approved patch for service.
2. Apply it to the orchestration layer.
3. Re-run the readiness probe.
4. Record the patch level in the deployment manifest.

## Verification
Confirm the readiness probe is within its expected bound and that the health endpoint reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the orchestration layer rather than a cached copy.

## Failure modes
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the deployment manifest from the recovery point identified in the preconditions, reattach service to the load balancer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `decommission-gateway`
- `archive-notification`
- `patch-datastore`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
The change owner must record what was observed against the operation id so the history stays reconstructable. The change owner is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the release registry returns an ambiguous response. The on-call responder should confirm the deployment manifest reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The change owner is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading. A reviewer checking the result afterwards should confirm the deployment manifest reflects the intended state before treating the step as complete. The change owner must not disable a check to make progress, because a failing check is information.

The change owner should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should confirm the health endpoint reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the load balancer actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response.

A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The change owner needs to confirm that the load balancer actually accepted the change and now reflects it. The operator running this procedure should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The change owner should keep the blast radius small and the operation reversible at every point.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The change owner should confirm the rollout config reflects the intended state before treating the step as complete. The operator running this procedure should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later needs to confirm that the release registry actually accepted the change and now reflects it.

The change owner should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session needs to confirm that the release registry actually accepted the change and now reflects it. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the load balancer returns an ambiguous response. The on-call responder should keep the blast radius small and the operation reversible at every point. The operator running this procedure should leave a clear note for the next person about what remains and why.
