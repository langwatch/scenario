---
id: reconcile-invoice
kind: procedure
keywords: [reconcile, invoice, audited, controlled, reversible]
links: [escalate-ticket, archive-invoice, offboard-vendor, reconcile-vendor]
status: active
---
# Reconcile Invoice

## Purpose
This procedure describes how to bring invoice into agreement with the source of truth. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around invoice:
- The line items
- The tax summary
- The payment reference
- The balance

## Procedure
1. Gather invoice from the reconciliation report.
2. Compare against the balance.
3. Resolve each discrepancy.
4. Confirm the settlement flag.

## Verification
Confirm the settlement flag is within its expected bound and that the line items reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the reconciliation report rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the payment reference from the recovery point identified in the preconditions, reattach invoice to the ledger, and confirm the settlement flag returns to baseline. Never leave invoice in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond invoice, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-invoice`
- `offboard-vendor`
- `reconcile-vendor`

## Notes and edge cases
- Tag every artifact you produce with the operation id so it can be correlated later.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.

## Additional considerations
The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner needs to confirm that the billing system actually accepted the change and now reflects it. The change owner needs to confirm that the billing system actually accepted the change and now reflects it. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should confirm the payment reference reflects the intended state before treating the step as complete. The change owner should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response. The on-call responder should prefer stopping over guessing whenever the billing system returns an ambiguous response. The person who signs off the operation should prefer stopping over guessing whenever the ledger returns an ambiguous response. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

The change owner should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards needs to confirm that the billing system actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder should keep the blast radius small and the operation reversible at every point.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should prefer stopping over guessing whenever the ledger returns an ambiguous response. An auditor reconstructing the timeline later is expected to verify the settlement flag independently rather than trusting a single reading. The on-call responder should prefer stopping over guessing whenever the ledger returns an ambiguous response.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The change owner must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session is expected to verify the settlement flag independently rather than trusting a single reading. The change owner should confirm the payment reference reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should confirm the payment reference reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards needs to confirm that the billing system actually accepted the change and now reflects it. The operator running this procedure is expected to verify the settlement flag independently rather than trusting a single reading. The person who signs off the operation should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response.
