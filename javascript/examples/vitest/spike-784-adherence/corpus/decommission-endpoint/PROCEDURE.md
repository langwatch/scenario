---
id: decommission-endpoint
kind: procedure
keywords: [decommission, endpoint, controlled, safety, recovery]
links: [escalate-ticket, scale-gateway, migrate-service, purge-report]
status: active
---
# Decommission Endpoint

## Purpose
This procedure describes how to retire endpoint and reclaim its resources cleanly. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around endpoint:
- The route table
- The rate limit
- The timeout budget
- The schema version

## Procedure
1. Confirm endpoint carries no live traffic.
2. Detach endpoint from the metrics pipeline.
3. Archive the rate limit.
4. Record the retirement.

## Verification
Confirm the latency SLO is within its expected bound and that the rate limit reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the metrics pipeline rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the route table from the recovery point identified in the preconditions, reattach endpoint to the metrics pipeline, and confirm the latency SLO returns to baseline. Never leave endpoint in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond endpoint, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `scale-gateway`
- `migrate-service`
- `purge-report`

## Notes and edge cases
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
The on-call responder should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure needs to confirm that the gateway actually accepted the change and now reflects it. The person who signs off the operation is expected to verify the latency SLO independently rather than trusting a single reading. The person who signs off the operation should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The operator running this procedure should prefer stopping over guessing whenever the traffic mesh returns an ambiguous response. The on-call responder is expected to verify the latency SLO independently rather than trusting a single reading. The on-call responder should confirm the schema version reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner should leave a clear note for the next person about what remains and why. The on-call responder should confirm the rate limit reflects the intended state before treating the step as complete.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should confirm the route table reflects the intended state before treating the step as complete. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The change owner should leave a clear note for the next person about what remains and why. The change owner should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response.

An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The on-call responder should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response. The operator running this procedure should confirm the route table reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The on-call responder should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response.

A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the gateway returns an ambiguous response. The person who signs off the operation should prefer stopping over guessing whenever the gateway returns an ambiguous response. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable.
