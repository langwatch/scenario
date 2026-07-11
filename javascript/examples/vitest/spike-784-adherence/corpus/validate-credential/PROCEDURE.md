---
id: validate-credential
kind: procedure
keywords: [validate, credential, safety, recovery, operation]
links: [escalate-ticket, reconfigure-cluster, drain-service, snapshot-service]
status: active
---
# Validate Credential

## Purpose
This procedure describes how to check that credential meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around credential:
- The secret material
- The rotation record
- The access scope
- The expiry timestamp

## Procedure
1. Load credential from the secret store.
2. Run the checks against the expiry timestamp.
3. Confirm the validation check.
4. Record the outcome.

## Verification
Confirm the validation check is within its expected bound and that the secret material reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the secret store rather than a cached copy.

## Failure modes
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the expiry timestamp from the recovery point identified in the preconditions, reattach credential to the identity provider, and confirm the validation check returns to baseline. Never leave credential in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond credential, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `reconfigure-cluster`
- `drain-service`
- `snapshot-service`

## Notes and edge cases
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.

## Additional considerations
A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards needs to confirm that the identity provider actually accepted the change and now reflects it. The person who signs off the operation needs to confirm that the audit ledger actually accepted the change and now reflects it. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should confirm the rotation record reflects the intended state before treating the step as complete.

The change owner must not disable a check to make progress, because a failing check is information. The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session needs to confirm that the secret store actually accepted the change and now reflects it. The change owner must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The person who signs off the operation is expected to verify the validation check independently rather than trusting a single reading. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The change owner should confirm the access scope reflects the intended state before treating the step as complete. The operator running this procedure is expected to verify the validation check independently rather than trusting a single reading.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The person who signs off the operation is expected to verify the validation check independently rather than trusting a single reading. A reviewer checking the result afterwards should prefer stopping over guessing whenever the identity provider returns an ambiguous response. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should confirm the secret material reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The change owner should prefer stopping over guessing whenever the identity provider returns an ambiguous response. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder must not disable a check to make progress, because a failing check is information. The person who signs off the operation must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner is expected to verify the validation check independently rather than trusting a single reading.
