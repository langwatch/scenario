---
id: review-vendor
kind: procedure
keywords: [review, vendor, audited, controlled, safety]
links: [escalate-ticket, provision-certificate, validate-dataset, revoke-access]
status: active
---
# Review Vendor

## Purpose
This procedure describes how to evaluate vendor and record an explicit decision. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around vendor:
- The vendor profile
- The contract terms
- The compliance attestation
- The contact set

## Procedure
1. Collect vendor and its context from the review board.
2. Assess it against the compliance attestation.
3. Record the decision.
4. Confirm the approval state.

## Verification
Confirm the approval state is within its expected bound and that the vendor profile reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the vendor directory rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the contract terms from the recovery point identified in the preconditions, reattach vendor to the procurement system, and confirm the approval state returns to baseline. Never leave vendor in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond vendor, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `provision-certificate`
- `validate-dataset`
- `revoke-access`

## Notes and edge cases
- Tag every artifact you produce with the operation id so it can be correlated later.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.

## Additional considerations
The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The on-call responder should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the review board returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should confirm the contract terms reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session needs to confirm that the procurement system actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The on-call responder must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards should confirm the compliance attestation reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the approval state independently rather than trusting a single reading. The change owner should confirm the compliance attestation reflects the intended state before treating the step as complete. The operator running this procedure is expected to verify the approval state independently rather than trusting a single reading. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

The on-call responder should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The on-call responder must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The on-call responder is expected to verify the approval state independently rather than trusting a single reading.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The on-call responder must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session needs to confirm that the review board actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session is expected to verify the approval state independently rather than trusting a single reading. The operator running this procedure should confirm the compliance attestation reflects the intended state before treating the step as complete.

The operator running this procedure should confirm the compliance attestation reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should confirm the contract terms reflects the intended state before treating the step as complete. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The change owner should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should prefer stopping over guessing whenever the procurement system returns an ambiguous response.
