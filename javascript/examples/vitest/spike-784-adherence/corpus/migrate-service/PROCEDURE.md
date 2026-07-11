---
id: migrate-service
kind: procedure
keywords: [migrate, service, reversible, runbook, procedure]
links: [escalate-ticket, validate-cache, reconcile-payment, patch-schema]
status: active
---
# Migrate Service

## Purpose
This procedure describes how to move service to a new format or location without loss. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Prepare the migration for service.
2. Apply it to the release registry.
3. Verify the readiness probe.
4. Reconcile the health endpoint.

## Verification
Confirm the readiness probe is within its expected bound and that the version tag reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the release registry rather than a cached copy.

## Failure modes
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the version tag from the recovery point identified in the preconditions, reattach service to the orchestration layer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-cache`
- `reconcile-payment`
- `patch-schema`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.

## Additional considerations
The on-call responder should keep the blast radius small and the operation reversible at every point. The person who signs off the operation must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the release registry returns an ambiguous response.

The operator running this procedure should prefer stopping over guessing whenever the release registry returns an ambiguous response. A reviewer checking the result afterwards needs to confirm that the load balancer actually accepted the change and now reflects it. The change owner should leave a clear note for the next person about what remains and why. The change owner should prefer stopping over guessing whenever the load balancer returns an ambiguous response. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why.

The on-call responder must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The person who signs off the operation needs to confirm that the orchestration layer actually accepted the change and now reflects it. The person who signs off the operation should confirm the deployment manifest reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable.

The on-call responder should keep the blast radius small and the operation reversible at every point. The operator running this procedure should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The person who signs off the operation is expected to verify the readiness probe independently rather than trusting a single reading. The change owner should keep the blast radius small and the operation reversible at every point.

The on-call responder needs to confirm that the release registry actually accepted the change and now reflects it. The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner should confirm the version tag reflects the intended state before treating the step as complete. The change owner must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should confirm the health endpoint reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response. The person who signs off the operation is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner should confirm the deployment manifest reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why.
