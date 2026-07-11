---
id: decommission-service
kind: procedure
keywords: [decommission, service, safety, controlled, operation]
links: [escalate-ticket, throttle-notification, restore-file, review-release]
status: active
---
# Decommission Service

## Purpose
This procedure describes how to retire service and reclaim its resources cleanly. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around service:
- The deployment manifest
- The health endpoint
- The version tag
- The rollout config

## Procedure
1. Confirm service carries no live traffic.
2. Detach service from the orchestration layer.
3. Archive the version tag.
4. Record the retirement.

## Verification
Confirm the readiness probe is within its expected bound and that the health endpoint reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the release registry rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the health endpoint from the recovery point identified in the preconditions, reattach service to the orchestration layer, and confirm the readiness probe returns to baseline. Never leave service in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond service, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `throttle-notification`
- `restore-file`
- `review-release`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.

## Additional considerations
The person who signs off the operation should confirm the health endpoint reflects the intended state before treating the step as complete. The change owner should confirm the version tag reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should confirm the version tag reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later needs to confirm that the load balancer actually accepted the change and now reflects it.

An auditor reconstructing the timeline later is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the rollout config reflects the intended state before treating the step as complete. The change owner is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the rollout config reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why.

The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The change owner must record what was observed against the operation id so the history stays reconstructable. The change owner should confirm the health endpoint reflects the intended state before treating the step as complete. The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder should confirm the health endpoint reflects the intended state before treating the step as complete.

The person who signs off the operation should confirm the deployment manifest reflects the intended state before treating the step as complete. The change owner should prefer stopping over guessing whenever the release registry returns an ambiguous response. The operator running this procedure should confirm the rollout config reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the orchestration layer returns an ambiguous response. The operator running this procedure needs to confirm that the load balancer actually accepted the change and now reflects it.

The operator running this procedure is expected to verify the readiness probe independently rather than trusting a single reading. The change owner is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the readiness probe independently rather than trusting a single reading. A reviewer checking the result afterwards is expected to verify the readiness probe independently rather than trusting a single reading. Anyone continuing this work in a follow-up session needs to confirm that the release registry actually accepted the change and now reflects it.

A reviewer checking the result afterwards should confirm the deployment manifest reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should confirm the health endpoint reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.
