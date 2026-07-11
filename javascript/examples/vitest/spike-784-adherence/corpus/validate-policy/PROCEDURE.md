---
id: validate-policy
kind: procedure
keywords: [validate, policy, controlled, safety, reversible]
links: [escalate-ticket, restart-gateway, review-access, restore-account]
status: active
---
# Validate Policy

## Purpose
This procedure describes how to check that policy meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around policy:
- The policy document
- The effective date
- The scope list
- The exception log

## Procedure
1. Load policy from the policy store.
2. Run the checks against the effective date.
3. Confirm the compliance state.
4. Record the outcome.

## Verification
Confirm the compliance state is within its expected bound and that the policy document reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the enforcement layer rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the policy document from the recovery point identified in the preconditions, reattach policy to the enforcement layer, and confirm the compliance state returns to baseline. Never leave policy in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond policy, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `restart-gateway`
- `review-access`
- `restore-account`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
An auditor reconstructing the timeline later is expected to verify the compliance state independently rather than trusting a single reading. The person who signs off the operation needs to confirm that the review board actually accepted the change and now reflects it. A reviewer checking the result afterwards should confirm the effective date reflects the intended state before treating the step as complete. The change owner is expected to verify the compliance state independently rather than trusting a single reading. The operator running this procedure should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response. The change owner must record what was observed against the operation id so the history stays reconstructable. The change owner must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should confirm the scope list reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the compliance state independently rather than trusting a single reading.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner is expected to verify the compliance state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the policy store returns an ambiguous response. A reviewer checking the result afterwards should confirm the effective date reflects the intended state before treating the step as complete.

An auditor reconstructing the timeline later should confirm the effective date reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response. The on-call responder should prefer stopping over guessing whenever the review board returns an ambiguous response. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder should keep the blast radius small and the operation reversible at every point.

An auditor reconstructing the timeline later is expected to verify the compliance state independently rather than trusting a single reading. The operator running this procedure needs to confirm that the enforcement layer actually accepted the change and now reflects it. The change owner must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should prefer stopping over guessing whenever the review board returns an ambiguous response. The change owner should prefer stopping over guessing whenever the review board returns an ambiguous response.

An auditor reconstructing the timeline later needs to confirm that the policy store actually accepted the change and now reflects it. The operator running this procedure is expected to verify the compliance state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The operator running this procedure should prefer stopping over guessing whenever the policy store returns an ambiguous response. An auditor reconstructing the timeline later needs to confirm that the policy store actually accepted the change and now reflects it.
