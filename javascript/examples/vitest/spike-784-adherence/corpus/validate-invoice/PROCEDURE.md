---
id: validate-invoice
kind: procedure
keywords: [validate, invoice, reversible, controlled, procedure]
links: [escalate-ticket, dispatch-payment, snapshot-cluster, patch-gateway]
status: active
---
# Validate Invoice

## Purpose
This procedure describes how to check that invoice meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around invoice:
- The line items
- The tax summary
- The payment reference
- The balance

## Procedure
1. Load invoice from the billing system.
2. Run the checks against the balance.
3. Confirm the settlement flag.
4. Record the outcome.

## Verification
Confirm the settlement flag is within its expected bound and that the tax summary reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the ledger rather than a cached copy.

## Failure modes
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the payment reference from the recovery point identified in the preconditions, reattach invoice to the ledger, and confirm the settlement flag returns to baseline. Never leave invoice in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond invoice, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `dispatch-payment`
- `snapshot-cluster`
- `patch-gateway`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.

## Additional considerations
The change owner should keep the blast radius small and the operation reversible at every point. The change owner is expected to verify the settlement flag independently rather than trusting a single reading. The on-call responder should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later needs to confirm that the reconciliation report actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point.

The on-call responder should confirm the payment reference reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The operator running this procedure should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards needs to confirm that the ledger actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The operator running this procedure should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should confirm the line items reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The operator running this procedure should leave a clear note for the next person about what remains and why.

The person who signs off the operation is expected to verify the settlement flag independently rather than trusting a single reading. The change owner is expected to verify the settlement flag independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The operator running this procedure should prefer stopping over guessing whenever the ledger returns an ambiguous response. The on-call responder needs to confirm that the billing system actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder is expected to verify the settlement flag independently rather than trusting a single reading. Anyone continuing this work in a follow-up session needs to confirm that the reconciliation report actually accepted the change and now reflects it. The change owner should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the ledger returns an ambiguous response. The operator running this procedure should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session needs to confirm that the ledger actually accepted the change and now reflects it.
