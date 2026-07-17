---
id: review-access
kind: procedure
keywords: [review, access, operation, safety, recovery]
links: [escalate-ticket, archive-report, patch-schema, offboard-account]
status: active
---
# Review Access Grant

## Purpose
This procedure describes how to evaluate access grant and record an explicit decision. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around access grant:
- The role binding
- The scope set
- The expiry
- The approval record

## Procedure
1. Collect access grant and its context from the directory.
2. Assess it against the role binding.
3. Record the decision.
4. Confirm the grant status.

## Verification
Confirm the grant status is within its expected bound and that the expiry reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the identity provider rather than a cached copy.

## Failure modes
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the scope set from the recovery point identified in the preconditions, reattach access grant to the identity provider, and confirm the grant status returns to baseline. Never leave access grant in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond access grant, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-report`
- `patch-schema`
- `offboard-account`

## Notes and edge cases
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
A reviewer checking the result afterwards should prefer stopping over guessing whenever the directory returns an ambiguous response. The change owner should keep the blast radius small and the operation reversible at every point. The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder should leave a clear note for the next person about what remains and why. The person who signs off the operation should confirm the role binding reflects the intended state before treating the step as complete.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The person who signs off the operation needs to confirm that the identity provider actually accepted the change and now reflects it. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should confirm the role binding reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session is expected to verify the grant status independently rather than trusting a single reading.

The operator running this procedure needs to confirm that the identity provider actually accepted the change and now reflects it. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session is expected to verify the grant status independently rather than trusting a single reading. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The change owner should leave a clear note for the next person about what remains and why.

The on-call responder needs to confirm that the identity provider actually accepted the change and now reflects it. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should confirm the role binding reflects the intended state before treating the step as complete. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

The on-call responder is expected to verify the grant status independently rather than trusting a single reading. The change owner needs to confirm that the audit ledger actually accepted the change and now reflects it. The operator running this procedure needs to confirm that the audit ledger actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should confirm the expiry reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the audit ledger returns an ambiguous response. The operator running this procedure should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner is expected to verify the grant status independently rather than trusting a single reading.
