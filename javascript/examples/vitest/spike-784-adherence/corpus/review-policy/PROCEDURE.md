---
id: review-policy
kind: procedure
keywords: [review, policy, procedure, operation, reversible]
links: [escalate-ticket, validate-refund, onboard-vendor, backup-datastore]
status: active
---
# Review Policy

## Purpose
This procedure describes how to evaluate policy and record an explicit decision. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around policy:
- The policy document
- The effective date
- The scope list
- The exception log

## Procedure
1. Collect policy and its context from the policy store.
2. Assess it against the exception log.
3. Record the decision.
4. Confirm the compliance state.

## Verification
Confirm the compliance state is within its expected bound and that the exception log reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the policy store rather than a cached copy.

## Failure modes
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the policy document from the recovery point identified in the preconditions, reattach policy to the policy store, and confirm the compliance state returns to baseline. Never leave policy in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond policy, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-refund`
- `onboard-vendor`
- `backup-datastore`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The change owner should prefer stopping over guessing whenever the review board returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the compliance state independently rather than trusting a single reading. The change owner should confirm the policy document reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the review board returns an ambiguous response.

The change owner should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should confirm the exception log reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later is expected to verify the compliance state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the exception log reflects the intended state before treating the step as complete.

The change owner needs to confirm that the review board actually accepted the change and now reflects it. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards is expected to verify the compliance state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later is expected to verify the compliance state independently rather than trusting a single reading.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure needs to confirm that the enforcement layer actually accepted the change and now reflects it. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the policy store returns an ambiguous response. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response.

The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder should confirm the policy document reflects the intended state before treating the step as complete. The on-call responder is expected to verify the compliance state independently rather than trusting a single reading. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must not disable a check to make progress, because a failing check is information.

The change owner needs to confirm that the policy store actually accepted the change and now reflects it. The operator running this procedure is expected to verify the compliance state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the compliance state independently rather than trusting a single reading. An auditor reconstructing the timeline later needs to confirm that the enforcement layer actually accepted the change and now reflects it. The on-call responder should keep the blast radius small and the operation reversible at every point.
