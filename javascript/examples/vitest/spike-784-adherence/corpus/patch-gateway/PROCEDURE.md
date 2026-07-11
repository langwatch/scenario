---
id: patch-gateway
kind: procedure
keywords: [patch, gateway, controlled, audited, procedure]
links: [escalate-ticket, throttle-notification, snapshot-release, backup-credential]
status: active
---
# Patch Gateway

## Purpose
This procedure describes how to apply a corrective change to gateway with minimal disruption. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around gateway:
- The routing rules
- The upstream pool
- The header policy
- The connection limits

## Procedure
1. Obtain the approved patch for gateway.
2. Apply it to the upstream services.
3. Re-run the health signal.
4. Record the patch level in the upstream pool.

## Verification
Confirm the health signal is within its expected bound and that the routing rules reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the upstream services rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the header policy from the recovery point identified in the preconditions, reattach gateway to the upstream services, and confirm the health signal returns to baseline. Never leave gateway in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond gateway, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `throttle-notification`
- `snapshot-release`
- `backup-credential`

## Notes and edge cases
- Tag every artifact you produce with the operation id so it can be correlated later.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
The change owner is expected to verify the health signal independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The person who signs off the operation should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The change owner is expected to verify the health signal independently rather than trusting a single reading.

An auditor reconstructing the timeline later should confirm the header policy reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the upstream services actually accepted the change and now reflects it. The change owner is expected to verify the health signal independently rather than trusting a single reading. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later is expected to verify the health signal independently rather than trusting a single reading. The person who signs off the operation is expected to verify the health signal independently rather than trusting a single reading. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must not disable a check to make progress, because a failing check is information.

The operator running this procedure should prefer stopping over guessing whenever the config store returns an ambiguous response. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should prefer stopping over guessing whenever the config store returns an ambiguous response.

An auditor reconstructing the timeline later needs to confirm that the edge tier actually accepted the change and now reflects it. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The operator running this procedure is expected to verify the health signal independently rather than trusting a single reading. The person who signs off the operation should leave a clear note for the next person about what remains and why. The operator running this procedure is expected to verify the health signal independently rather than trusting a single reading.

The operator running this procedure must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards is expected to verify the health signal independently rather than trusting a single reading. The change owner should confirm the connection limits reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should confirm the header policy reflects the intended state before treating the step as complete. The change owner should confirm the routing rules reflects the intended state before treating the step as complete.
