---
id: publish-policy
kind: procedure
keywords: [publish, policy, recovery, procedure, reversible]
links: [escalate-ticket, purge-record, offboard-vendor, purge-queue]
status: active
---
# Publish Policy

## Purpose
This procedure describes how to make policy available to its consumers under change control. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around policy:
- The policy document
- The effective date
- The scope list
- The exception log

## Procedure
1. Finalize policy.
2. Promote the exception log through the review board.
3. Confirm the compliance state.
4. Announce availability.

## Verification
Confirm the compliance state is within its expected bound and that the exception log reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the review board rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the policy document from the recovery point identified in the preconditions, reattach policy to the policy store, and confirm the compliance state returns to baseline. Never leave policy in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond policy, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `purge-record`
- `offboard-vendor`
- `purge-queue`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Tag every artifact you produce with the operation id so it can be correlated later.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.

## Additional considerations
The on-call responder should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should confirm the policy document reflects the intended state before treating the step as complete. The change owner is expected to verify the compliance state independently rather than trusting a single reading. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder should keep the blast radius small and the operation reversible at every point.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards needs to confirm that the policy store actually accepted the change and now reflects it. The on-call responder needs to confirm that the review board actually accepted the change and now reflects it. The operator running this procedure is expected to verify the compliance state independently rather than trusting a single reading. The on-call responder should prefer stopping over guessing whenever the review board returns an ambiguous response.

The change owner should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards needs to confirm that the enforcement layer actually accepted the change and now reflects it. The person who signs off the operation should prefer stopping over guessing whenever the review board returns an ambiguous response. The change owner should confirm the exception log reflects the intended state before treating the step as complete.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. The on-call responder is expected to verify the compliance state independently rather than trusting a single reading. The on-call responder is expected to verify the compliance state independently rather than trusting a single reading. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The on-call responder should confirm the effective date reflects the intended state before treating the step as complete.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session is expected to verify the compliance state independently rather than trusting a single reading. The operator running this procedure must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should confirm the scope list reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the compliance state independently rather than trusting a single reading.

The change owner should prefer stopping over guessing whenever the review board returns an ambiguous response. The change owner is expected to verify the compliance state independently rather than trusting a single reading. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the review board returns an ambiguous response. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The operator running this procedure should keep the blast radius small and the operation reversible at every point.
