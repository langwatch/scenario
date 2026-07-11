---
id: audit-service
kind: procedure
keywords: [audit, service, controlled, audited, safety]
links: [escalate-ticket, purge-file, decommission-account, replicate-datastore]
status: active
---
# Audit Service

## Purpose
This procedure describes how to review service against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Enumerate service in the load balancer.
2. Compare each against policy.
3. Record deviations in the health endpoint.
4. Confirm the readiness probe.

## Verification
Confirm the readiness probe is within its expected bound and that the version tag reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the orchestration layer rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the version tag from the recovery point identified in the preconditions, reattach service to the orchestration layer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `purge-file`
- `decommission-account`
- `replicate-datastore`

## Notes and edge cases
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.

## Additional considerations
The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner should prefer stopping over guessing whenever the load balancer returns an ambiguous response. The operator running this procedure must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The person who signs off the operation is expected to verify the readiness probe independently rather than trusting a single reading.

The person who signs off the operation should confirm the health endpoint reflects the intended state before treating the step as complete. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why.

The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session needs to confirm that the orchestration layer actually accepted the change and now reflects it. The person who signs off the operation should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should confirm the health endpoint reflects the intended state before treating the step as complete. The operator running this procedure must not disable a check to make progress, because a failing check is information. The on-call responder should prefer stopping over guessing whenever the release registry returns an ambiguous response. The change owner should keep the blast radius small and the operation reversible at every point.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The operator running this procedure should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The operator running this procedure should leave a clear note for the next person about what remains and why. The on-call responder should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading. The on-call responder is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder should leave a clear note for the next person about what remains and why.
