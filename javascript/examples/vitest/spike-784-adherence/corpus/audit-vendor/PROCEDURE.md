---
id: audit-vendor
kind: procedure
keywords: [audit, vendor, safety, procedure, recovery]
links: [escalate-ticket, validate-report, reconcile-access, snapshot-gateway]
status: active
---
# Audit Vendor

## Purpose
This procedure describes how to review vendor against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around vendor:
- The vendor profile
- The contract terms
- The compliance attestation
- The contact set

## Procedure
1. Enumerate vendor in the procurement system.
2. Compare each against policy.
3. Record deviations in the contact set.
4. Confirm the approval state.

## Verification
Confirm the approval state is within its expected bound and that the compliance attestation reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the procurement system rather than a cached copy.

## Failure modes
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the contact set from the recovery point identified in the preconditions, reattach vendor to the procurement system, and confirm the approval state returns to baseline. Never leave vendor in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond vendor, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-report`
- `reconcile-access`
- `snapshot-gateway`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.

## Additional considerations
A reviewer checking the result afterwards should prefer stopping over guessing whenever the vendor directory returns an ambiguous response. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the procurement system returns an ambiguous response. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The on-call responder must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session needs to confirm that the vendor directory actually accepted the change and now reflects it. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The on-call responder should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should confirm the vendor profile reflects the intended state before treating the step as complete.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The change owner should leave a clear note for the next person about what remains and why. The on-call responder must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should confirm the compliance attestation reflects the intended state before treating the step as complete.

An auditor reconstructing the timeline later is expected to verify the approval state independently rather than trusting a single reading. The on-call responder should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The on-call responder needs to confirm that the vendor directory actually accepted the change and now reflects it.

A reviewer checking the result afterwards is expected to verify the approval state independently rather than trusting a single reading. The person who signs off the operation should leave a clear note for the next person about what remains and why. The person who signs off the operation is expected to verify the approval state independently rather than trusting a single reading. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation needs to confirm that the procurement system actually accepted the change and now reflects it.

An auditor reconstructing the timeline later is expected to verify the approval state independently rather than trusting a single reading. The operator running this procedure should prefer stopping over guessing whenever the vendor directory returns an ambiguous response. The on-call responder needs to confirm that the review board actually accepted the change and now reflects it. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the review board returns an ambiguous response. The operator running this procedure must not disable a check to make progress, because a failing check is information.
