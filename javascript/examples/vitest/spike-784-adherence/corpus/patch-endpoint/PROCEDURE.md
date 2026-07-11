---
id: patch-endpoint
kind: procedure
keywords: [patch, endpoint, audited, operation, recovery]
links: [escalate-ticket, audit-invoice, reconfigure-cache, warm-cache]
status: active
---
# Patch Endpoint

## Purpose
This procedure describes how to apply a corrective change to endpoint with minimal disruption. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around endpoint:
- The route table
- The rate limit
- The timeout budget
- The schema version

## Procedure
1. Obtain the approved patch for endpoint.
2. Apply it to the traffic mesh.
3. Re-run the latency SLO.
4. Record the patch level in the timeout budget.

## Verification
Confirm the latency SLO is within its expected bound and that the timeout budget reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the metrics pipeline rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the schema version from the recovery point identified in the preconditions, reattach endpoint to the metrics pipeline, and confirm the latency SLO returns to baseline. Never leave endpoint in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond endpoint, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-invoice`
- `reconfigure-cache`
- `warm-cache`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner should confirm the timeout budget reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the latency SLO independently rather than trusting a single reading. The change owner must not disable a check to make progress, because a failing check is information. The on-call responder must not disable a check to make progress, because a failing check is information.

An auditor reconstructing the timeline later is expected to verify the latency SLO independently rather than trusting a single reading. The person who signs off the operation should confirm the route table reflects the intended state before treating the step as complete. The person who signs off the operation should confirm the rate limit reflects the intended state before treating the step as complete. The change owner needs to confirm that the metrics pipeline actually accepted the change and now reflects it. The change owner is expected to verify the latency SLO independently rather than trusting a single reading.

The on-call responder should prefer stopping over guessing whenever the gateway returns an ambiguous response. The operator running this procedure needs to confirm that the gateway actually accepted the change and now reflects it. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The on-call responder should prefer stopping over guessing whenever the traffic mesh returns an ambiguous response. Anyone continuing this work in a follow-up session needs to confirm that the traffic mesh actually accepted the change and now reflects it.

The operator running this procedure needs to confirm that the traffic mesh actually accepted the change and now reflects it. The on-call responder should prefer stopping over guessing whenever the gateway returns an ambiguous response. The person who signs off the operation needs to confirm that the traffic mesh actually accepted the change and now reflects it. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The change owner is expected to verify the latency SLO independently rather than trusting a single reading.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The change owner should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. The operator running this procedure must not disable a check to make progress, because a failing check is information. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information.

The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner should prefer stopping over guessing whenever the traffic mesh returns an ambiguous response. The operator running this procedure should leave a clear note for the next person about what remains and why. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable.
