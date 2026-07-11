---
id: handle-refund
kind: procedure
keywords: [handle, refund, procedure, recovery, operation]
links: [reconcile-invoice, escalate-ticket, publish-report, patch-schema]
status: active
---
# Handle Refund

## Purpose
This procedure describes how to process refund end-to-end within policy. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around refund:
- The refund request
- The original charge
- The refund amount
- The reason code

## Procedure
1. Intake refund and confirm eligibility.
2. Process it through the payment processor.
3. Record the original charge.
4. Confirm the refund state.

## Verification
Confirm the refund state is within its expected bound and that the original charge reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the payment processor rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the refund request from the recovery point identified in the preconditions, reattach refund to the ledger, and confirm the refund state returns to baseline. Never leave refund in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond refund, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Follow-on procedures
After the steps above are complete, follow procedure `reconcile-invoice` to carry out the required follow-on work. This is a transitive hand-off: the wider task is not finished until `reconcile-invoice` has also been completed in full.

## Related procedures
- `reconcile-invoice`
- `escalate-ticket`
- `publish-report`
- `patch-schema`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.

## Additional considerations
The operator running this procedure should prefer stopping over guessing whenever the ledger returns an ambiguous response. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The person who signs off the operation should confirm the original charge reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session is expected to verify the refund state independently rather than trusting a single reading. The person who signs off the operation should confirm the refund amount reflects the intended state before treating the step as complete.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the case queue returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the refund state independently rather than trusting a single reading. The change owner should confirm the original charge reflects the intended state before treating the step as complete. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.

A reviewer checking the result afterwards should confirm the reason code reflects the intended state before treating the step as complete. The change owner is expected to verify the refund state independently rather than trusting a single reading. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards is expected to verify the refund state independently rather than trusting a single reading. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards should confirm the refund request reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the ledger actually accepted the change and now reflects it. The operator running this procedure should confirm the refund amount reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should prefer stopping over guessing whenever the payment processor returns an ambiguous response. The person who signs off the operation is expected to verify the refund state independently rather than trusting a single reading.

The on-call responder must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later is expected to verify the refund state independently rather than trusting a single reading. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should confirm the reason code reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the refund state independently rather than trusting a single reading. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner must record what was observed against the operation id so the history stays reconstructable.
