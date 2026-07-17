---
id: offboard-vendor
kind: procedure
keywords: [offboard, vendor, controlled, reversible, runbook]
links: [escalate-ticket, archive-certificate, backup-datastore, reconfigure-queue]
status: active
---
# Offboard Vendor

## Purpose
This procedure describes how to remove vendor from the system and revoke its access. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around vendor:
- The vendor profile
- The contract terms
- The compliance attestation
- The contact set

## Procedure
1. Confirm vendor is departing.
2. Revoke access in the vendor directory.
3. Archive the vendor profile.
4. Confirm the approval state.

## Verification
Confirm the approval state is within its expected bound and that the compliance attestation reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the procurement system rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the contact set from the recovery point identified in the preconditions, reattach vendor to the review board, and confirm the approval state returns to baseline. Never leave vendor in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond vendor, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-certificate`
- `backup-datastore`
- `reconfigure-queue`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.

## Additional considerations
The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner needs to confirm that the procurement system actually accepted the change and now reflects it. A reviewer checking the result afterwards needs to confirm that the vendor directory actually accepted the change and now reflects it. A reviewer checking the result afterwards should confirm the vendor profile reflects the intended state before treating the step as complete. The person who signs off the operation should prefer stopping over guessing whenever the vendor directory returns an ambiguous response.

The change owner should confirm the compliance attestation reflects the intended state before treating the step as complete. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the contact set reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should confirm the vendor profile reflects the intended state before treating the step as complete. The person who signs off the operation is expected to verify the approval state independently rather than trusting a single reading.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder needs to confirm that the procurement system actually accepted the change and now reflects it. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The change owner needs to confirm that the review board actually accepted the change and now reflects it.

The change owner must not disable a check to make progress, because a failing check is information. The change owner should confirm the vendor profile reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards is expected to verify the approval state independently rather than trusting a single reading. The on-call responder should keep the blast radius small and the operation reversible at every point.

The person who signs off the operation should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder needs to confirm that the review board actually accepted the change and now reflects it. The person who signs off the operation should prefer stopping over guessing whenever the vendor directory returns an ambiguous response.

The person who signs off the operation should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The on-call responder is expected to verify the approval state independently rather than trusting a single reading. The person who signs off the operation needs to confirm that the vendor directory actually accepted the change and now reflects it.
