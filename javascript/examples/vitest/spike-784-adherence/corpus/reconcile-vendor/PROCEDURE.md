---
id: reconcile-vendor
kind: procedure
keywords: [reconcile, vendor, controlled, runbook, reversible]
links: [escalate-ticket, reconfigure-service, audit-gateway, archive-payment]
status: active
---
# Reconcile Vendor

## Purpose
This procedure describes how to bring vendor into agreement with the source of truth. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around vendor:
- The vendor profile
- The contract terms
- The compliance attestation
- The contact set

## Procedure
1. Gather vendor from the vendor directory.
2. Compare against the contact set.
3. Resolve each discrepancy.
4. Confirm the approval state.

## Verification
Confirm the approval state is within its expected bound and that the compliance attestation reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the vendor directory rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the vendor profile from the recovery point identified in the preconditions, reattach vendor to the vendor directory, and confirm the approval state returns to baseline. Never leave vendor in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond vendor, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `reconfigure-service`
- `audit-gateway`
- `archive-payment`

## Notes and edge cases
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.

## Additional considerations
The on-call responder must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner needs to confirm that the procurement system actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the vendor directory returns an ambiguous response. The person who signs off the operation needs to confirm that the vendor directory actually accepted the change and now reflects it.

The operator running this procedure must not disable a check to make progress, because a failing check is information. The operator running this procedure is expected to verify the approval state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session is expected to verify the approval state independently rather than trusting a single reading. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session needs to confirm that the review board actually accepted the change and now reflects it. The operator running this procedure should confirm the contact set reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session needs to confirm that the procurement system actually accepted the change and now reflects it.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The operator running this procedure is expected to verify the approval state independently rather than trusting a single reading. The operator running this procedure should prefer stopping over guessing whenever the procurement system returns an ambiguous response. The change owner needs to confirm that the procurement system actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session needs to confirm that the vendor directory actually accepted the change and now reflects it. The person who signs off the operation should prefer stopping over guessing whenever the review board returns an ambiguous response. The operator running this procedure is expected to verify the approval state independently rather than trusting a single reading. The person who signs off the operation needs to confirm that the procurement system actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point.

The operator running this procedure needs to confirm that the procurement system actually accepted the change and now reflects it. The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure is expected to verify the approval state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the vendor directory returns an ambiguous response. The on-call responder should leave a clear note for the next person about what remains and why.
