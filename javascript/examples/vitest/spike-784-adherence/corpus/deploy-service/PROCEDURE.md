---
id: deploy-service
kind: procedure
keywords: [deploy, service, operation, audited, procedure]
links: [purge-cache, escalate-ticket, reconcile-policy, restore-credential]
status: active
---
# Deploy Service

## Purpose
This procedure describes how to roll a new version of service into production safely and reversibly. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Stage the change behind a guard.
2. Promote service incrementally.
3. Watch the readiness probe during rollout.
4. Confirm the version tag matches the intended version.

## Verification
Confirm the readiness probe is within its expected bound and that the rollout config reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the orchestration layer rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the health endpoint from the recovery point identified in the preconditions, reattach service to the orchestration layer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Follow-on procedures
After the steps above are complete, follow procedure `purge-cache` to carry out the required follow-on work. This is a transitive hand-off: the wider task is not finished until `purge-cache` has also been completed in full.

## Related procedures
- `purge-cache`
- `escalate-ticket`
- `reconcile-policy`
- `restore-credential`

## Notes and edge cases
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.

## Additional considerations
The change owner is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading. The on-call responder should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The change owner should confirm the deployment manifest reflects the intended state before treating the step as complete. The operator running this procedure should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response. The person who signs off the operation should leave a clear note for the next person about what remains and why. The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should prefer stopping over guessing whenever the load balancer returns an ambiguous response. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the load balancer returns an ambiguous response.

A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The person who signs off the operation needs to confirm that the orchestration layer actually accepted the change and now reflects it. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the release registry returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

The on-call responder must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the load balancer returns an ambiguous response. The on-call responder should leave a clear note for the next person about what remains and why.

The change owner needs to confirm that the release registry actually accepted the change and now reflects it. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder is expected to verify the readiness probe independently rather than trusting a single reading. The change owner should confirm the deployment manifest reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading.
