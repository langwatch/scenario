---
id: restore-service
kind: procedure
keywords: [restore, service, audited, reversible, recovery]
links: [escalate-ticket, decommission-endpoint, audit-service, revoke-credential]
status: active
---
# Restore Service

## Purpose
This procedure describes how to recover service from a known-good copy. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Select the recovery point for service.
2. Restore the deployment manifest into the orchestration layer.
3. Verify the readiness probe.
4. Reconcile any gap.

## Verification
Confirm the readiness probe is within its expected bound and that the rollout config reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the orchestration layer rather than a cached copy.

## Failure modes
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the rollout config from the recovery point identified in the preconditions, reattach service to the load balancer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `decommission-endpoint`
- `audit-service`
- `revoke-credential`

## Notes and edge cases
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
The person who signs off the operation should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the load balancer returns an ambiguous response. Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The on-call responder should leave a clear note for the next person about what remains and why.

The change owner should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards is expected to verify the readiness probe independently rather than trusting a single reading. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The change owner should leave a clear note for the next person about what remains and why. The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading.

The change owner must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The change owner should confirm the rollout config reflects the intended state before treating the step as complete.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The on-call responder needs to confirm that the release registry actually accepted the change and now reflects it. The person who signs off the operation should leave a clear note for the next person about what remains and why. The operator running this procedure should confirm the rollout config reflects the intended state before treating the step as complete. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

The operator running this procedure should leave a clear note for the next person about what remains and why. The person who signs off the operation should confirm the version tag reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading.

The change owner must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later needs to confirm that the release registry actually accepted the change and now reflects it.
