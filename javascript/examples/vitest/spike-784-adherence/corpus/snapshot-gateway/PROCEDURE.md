---
id: snapshot-gateway
kind: procedure
keywords: [snapshot, gateway, audited, operation, safety]
links: [escalate-ticket, warm-cache, replicate-cluster, snapshot-release]
status: active
---
# Snapshot Gateway

## Purpose
This procedure describes how to capture a consistent point-in-time copy of gateway. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around gateway:
- The routing rules
- The upstream pool
- The header policy
- The connection limits

## Procedure
1. Quiesce writes to gateway.
2. Capture the header policy.
3. Verify the snapshot against the health signal.
4. Register it in the edge tier.

## Verification
Confirm the health signal is within its expected bound and that the upstream pool reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the upstream services rather than a cached copy.

## Failure modes
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the routing rules from the recovery point identified in the preconditions, reattach gateway to the edge tier, and confirm the health signal returns to baseline. Never leave gateway in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond gateway, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `warm-cache`
- `replicate-cluster`
- `snapshot-release`

## Notes and edge cases
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The change owner must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the upstream services returns an ambiguous response. The operator running this procedure should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session is expected to verify the health signal independently rather than trusting a single reading. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should prefer stopping over guessing whenever the config store returns an ambiguous response. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

The change owner needs to confirm that the edge tier actually accepted the change and now reflects it. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The on-call responder needs to confirm that the config store actually accepted the change and now reflects it. The person who signs off the operation should prefer stopping over guessing whenever the edge tier returns an ambiguous response. The on-call responder should confirm the routing rules reflects the intended state before treating the step as complete.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The change owner should confirm the header policy reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should prefer stopping over guessing whenever the config store returns an ambiguous response. The person who signs off the operation should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the upstream services returns an ambiguous response. A reviewer checking the result afterwards needs to confirm that the edge tier actually accepted the change and now reflects it. The operator running this procedure should prefer stopping over guessing whenever the config store returns an ambiguous response.

An auditor reconstructing the timeline later is expected to verify the health signal independently rather than trusting a single reading. The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the routing rules reflects the intended state before treating the step as complete. The change owner should confirm the routing rules reflects the intended state before treating the step as complete. The person who signs off the operation should prefer stopping over guessing whenever the edge tier returns an ambiguous response.
