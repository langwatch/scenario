---
id: throttle-endpoint
kind: procedure
keywords: [throttle, endpoint, reversible, recovery, controlled]
links: [escalate-ticket, validate-refund, rotate-credential, validate-release]
status: active
---
# Throttle Endpoint

## Purpose
This procedure describes how to limit the rate at which endpoint is served to protect the system. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around endpoint:
- The route table
- The rate limit
- The timeout budget
- The schema version

## Procedure
1. Measure current pressure on endpoint.
2. Set the limit in the traffic mesh.
3. Watch the latency SLO.
4. Record the applied limit in the route table.

## Verification
Confirm the latency SLO is within its expected bound and that the timeout budget reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the traffic mesh rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the timeout budget from the recovery point identified in the preconditions, reattach endpoint to the traffic mesh, and confirm the latency SLO returns to baseline. Never leave endpoint in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond endpoint, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-refund`
- `rotate-credential`
- `validate-release`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.

## Additional considerations
The person who signs off the operation should confirm the route table reflects the intended state before treating the step as complete. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later needs to confirm that the traffic mesh actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should confirm the schema version reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner should prefer stopping over guessing whenever the gateway returns an ambiguous response.

A reviewer checking the result afterwards is expected to verify the latency SLO independently rather than trusting a single reading. A reviewer checking the result afterwards needs to confirm that the traffic mesh actually accepted the change and now reflects it. The change owner must not disable a check to make progress, because a failing check is information. The change owner needs to confirm that the gateway actually accepted the change and now reflects it. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session needs to confirm that the metrics pipeline actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

An auditor reconstructing the timeline later is expected to verify the latency SLO independently rather than trusting a single reading. An auditor reconstructing the timeline later needs to confirm that the traffic mesh actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder should keep the blast radius small and the operation reversible at every point. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards needs to confirm that the gateway actually accepted the change and now reflects it. The change owner must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the gateway returns an ambiguous response. The operator running this procedure should prefer stopping over guessing whenever the metrics pipeline returns an ambiguous response.
