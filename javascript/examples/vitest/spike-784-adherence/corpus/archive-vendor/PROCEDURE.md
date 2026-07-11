---
id: archive-vendor
kind: procedure
keywords: [archive, vendor, procedure, runbook, reversible]
links: [escalate-ticket, purge-record, snapshot-gateway, migrate-service]
status: active
---
# Archive Vendor

## Purpose
This procedure describes how to move vendor to long-term storage under its retention rules. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around vendor:
- The vendor profile
- The contract terms
- The compliance attestation
- The contact set

## Procedure
1. Confirm vendor is eligible for archival.
2. Move the contact set to the review board.
3. Verify the approval state.
4. Update the index.

## Verification
Confirm the approval state is within its expected bound and that the compliance attestation reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the procurement system rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the compliance attestation from the recovery point identified in the preconditions, reattach vendor to the review board, and confirm the approval state returns to baseline. Never leave vendor in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond vendor, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `purge-record`
- `snapshot-gateway`
- `migrate-service`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the vendor profile reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The on-call responder should confirm the vendor profile reflects the intended state before treating the step as complete.

The operator running this procedure needs to confirm that the procurement system actually accepted the change and now reflects it. The on-call responder should prefer stopping over guessing whenever the procurement system returns an ambiguous response. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The on-call responder must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should confirm the contact set reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The change owner needs to confirm that the procurement system actually accepted the change and now reflects it. The change owner is expected to verify the approval state independently rather than trusting a single reading.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should confirm the contact set reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The operator running this procedure is expected to verify the approval state independently rather than trusting a single reading. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.

The person who signs off the operation should confirm the contact set reflects the intended state before treating the step as complete. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The operator running this procedure is expected to verify the approval state independently rather than trusting a single reading. The operator running this procedure should confirm the contact set reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the approval state independently rather than trusting a single reading. The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner should leave a clear note for the next person about what remains and why.
