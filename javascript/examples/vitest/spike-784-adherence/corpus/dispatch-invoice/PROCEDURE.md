---
id: dispatch-invoice
kind: procedure
keywords: [dispatch, invoice, safety, recovery, procedure]
links: [escalate-ticket, reconcile-access, provision-gateway, reconfigure-queue]
status: active
---
# Dispatch Invoice

## Purpose
This procedure describes how to send invoice to its recipients reliably. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around invoice:
- The line items
- The tax summary
- The payment reference
- The balance

## Procedure
1. Assemble invoice from the balance.
2. Hand it to the ledger.
3. Confirm the settlement flag.
4. Record delivery.

## Verification
Confirm the settlement flag is within its expected bound and that the line items reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the reconciliation report rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the balance from the recovery point identified in the preconditions, reattach invoice to the billing system, and confirm the settlement flag returns to baseline. Never leave invoice in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond invoice, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `reconcile-access`
- `provision-gateway`
- `reconfigure-queue`

## Notes and edge cases
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner needs to confirm that the ledger actually accepted the change and now reflects it. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation needs to confirm that the billing system actually accepted the change and now reflects it.

The operator running this procedure is expected to verify the settlement flag independently rather than trusting a single reading. The on-call responder must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The person who signs off the operation should prefer stopping over guessing whenever the billing system returns an ambiguous response.

An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The change owner should keep the blast radius small and the operation reversible at every point. The operator running this procedure should confirm the payment reference reflects the intended state before treating the step as complete. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later is expected to verify the settlement flag independently rather than trusting a single reading.

The operator running this procedure needs to confirm that the reconciliation report actually accepted the change and now reflects it. The person who signs off the operation should prefer stopping over guessing whenever the billing system returns an ambiguous response. The person who signs off the operation needs to confirm that the ledger actually accepted the change and now reflects it. The change owner must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The person who signs off the operation is expected to verify the settlement flag independently rather than trusting a single reading. The operator running this procedure is expected to verify the settlement flag independently rather than trusting a single reading. The on-call responder should prefer stopping over guessing whenever the billing system returns an ambiguous response. An auditor reconstructing the timeline later should confirm the balance reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information.

The on-call responder is expected to verify the settlement flag independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response. The person who signs off the operation should confirm the balance reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards needs to confirm that the reconciliation report actually accepted the change and now reflects it.
