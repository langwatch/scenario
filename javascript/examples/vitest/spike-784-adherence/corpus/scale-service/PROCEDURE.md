---
id: scale-service
kind: procedure
keywords: [scale, service, audited, procedure, safety]
links: [escalate-ticket, replicate-service, handle-refund, grant-access]
status: active
---
# Scale Service

## Purpose
This procedure describes how to adjust the capacity of service to meet demand. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Measure current load on service.
2. Compute the target capacity.
3. Apply the change to the load balancer.
4. Watch the readiness probe stabilize.

## Verification
Confirm the readiness probe is within its expected bound and that the version tag reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the release registry rather than a cached copy.

## Failure modes
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the version tag from the recovery point identified in the preconditions, reattach service to the load balancer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `replicate-service`
- `handle-refund`
- `grant-access`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
The on-call responder needs to confirm that the release registry actually accepted the change and now reflects it. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should confirm the deployment manifest reflects the intended state before treating the step as complete. The operator running this procedure should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The on-call responder is expected to verify the readiness probe independently rather than trusting a single reading. An auditor reconstructing the timeline later should confirm the rollout config reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The person who signs off the operation should confirm the rollout config reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session should confirm the health endpoint reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the readiness probe independently rather than trusting a single reading. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards is expected to verify the readiness probe independently rather than trusting a single reading.

A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The change owner should leave a clear note for the next person about what remains and why. The on-call responder is expected to verify the readiness probe independently rather than trusting a single reading.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading. The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The change owner needs to confirm that the orchestration layer actually accepted the change and now reflects it. The on-call responder should confirm the health endpoint reflects the intended state before treating the step as complete. The operator running this procedure needs to confirm that the release registry actually accepted the change and now reflects it.
