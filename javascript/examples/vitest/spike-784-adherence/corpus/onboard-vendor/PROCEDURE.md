---
id: onboard-vendor
kind: procedure
keywords: [onboard, vendor, controlled, procedure, runbook]
links: [provision-account, escalate-ticket, warm-cache, audit-service]
status: active
---
# Onboard Vendor

## Purpose
This procedure describes how to bring vendor into the system with all prerequisites met. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around vendor:
- The vendor profile
- The contract terms
- The compliance attestation
- The contact set

## Procedure
1. Collect the intake details for vendor.
2. Create the records in the review board.
3. Attach the contact set.
4. Confirm the approval state.

## Verification
Confirm the approval state is within its expected bound and that the contract terms reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the review board rather than a cached copy.

## Failure modes
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the vendor profile from the recovery point identified in the preconditions, reattach vendor to the vendor directory, and confirm the approval state returns to baseline. Never leave vendor in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond vendor, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Follow-on procedures
After the steps above are complete, follow procedure `provision-account` to carry out the required follow-on work. This is a transitive hand-off: the wider task is not finished until `provision-account` has also been completed in full.

## Related procedures
- `provision-account`
- `escalate-ticket`
- `warm-cache`
- `audit-service`

## Notes and edge cases
- Tag every artifact you produce with the operation id so it can be correlated later.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.

## Additional considerations
The person who signs off the operation is expected to verify the approval state independently rather than trusting a single reading. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The operator running this procedure needs to confirm that the review board actually accepted the change and now reflects it.

A reviewer checking the result afterwards should confirm the compliance attestation reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should prefer stopping over guessing whenever the vendor directory returns an ambiguous response. The change owner is expected to verify the approval state independently rather than trusting a single reading. The on-call responder is expected to verify the approval state independently rather than trusting a single reading. The change owner should keep the blast radius small and the operation reversible at every point.

A reviewer checking the result afterwards is expected to verify the approval state independently rather than trusting a single reading. The change owner should confirm the contact set reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later is expected to verify the approval state independently rather than trusting a single reading. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The on-call responder should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The change owner is expected to verify the approval state independently rather than trusting a single reading. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner should confirm the contact set reflects the intended state before treating the step as complete. The operator running this procedure should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should confirm the contract terms reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards should confirm the contact set reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should confirm the vendor profile reflects the intended state before treating the step as complete. The change owner should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The operator running this procedure should confirm the contract terms reflects the intended state before treating the step as complete.
