---
id: reconcile-access
kind: procedure
keywords: [reconcile, access, procedure, audited, reversible]
links: [escalate-ticket, archive-policy, provision-credential, reconcile-report]
status: active
---
# Reconcile Access Grant

## Purpose
This procedure describes how to bring access grant into agreement with the source of truth. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around access grant:
- The role binding
- The scope set
- The expiry
- The approval record

## Procedure
1. Gather access grant from the directory.
2. Compare against the expiry.
3. Resolve each discrepancy.
4. Confirm the grant status.

## Verification
Confirm the grant status is within its expected bound and that the scope set reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the directory rather than a cached copy.

## Failure modes
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the expiry from the recovery point identified in the preconditions, reattach access grant to the directory, and confirm the grant status returns to baseline. Never leave access grant in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond access grant, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-policy`
- `provision-credential`
- `reconcile-report`

## Notes and edge cases
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.

## Additional considerations
Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the scope set reflects the intended state before treating the step as complete. The operator running this procedure must not disable a check to make progress, because a failing check is information. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner should leave a clear note for the next person about what remains and why.

The on-call responder is expected to verify the grant status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session needs to confirm that the directory actually accepted the change and now reflects it. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards needs to confirm that the directory actually accepted the change and now reflects it. The operator running this procedure should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards should confirm the expiry reflects the intended state before treating the step as complete. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the scope set reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the directory actually accepted the change and now reflects it. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

The operator running this procedure needs to confirm that the identity provider actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder should prefer stopping over guessing whenever the identity provider returns an ambiguous response. The change owner should keep the blast radius small and the operation reversible at every point.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards needs to confirm that the directory actually accepted the change and now reflects it. The change owner needs to confirm that the audit ledger actually accepted the change and now reflects it. The person who signs off the operation should leave a clear note for the next person about what remains and why. The operator running this procedure should prefer stopping over guessing whenever the directory returns an ambiguous response.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session needs to confirm that the directory actually accepted the change and now reflects it. The operator running this procedure needs to confirm that the directory actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.
