---
id: archive-invoice
kind: procedure
keywords: [archive, invoice, controlled, runbook, reversible]
links: [escalate-ticket, audit-access, audit-credential, audit-account]
status: active
---
# Archive Invoice

## Purpose
This procedure describes how to move invoice to long-term storage under its retention rules. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around invoice:
- The line items
- The tax summary
- The payment reference
- The balance

## Procedure
1. Confirm invoice is eligible for archival.
2. Move the payment reference to the reconciliation report.
3. Verify the settlement flag.
4. Update the index.

## Verification
Confirm the settlement flag is within its expected bound and that the balance reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the billing system rather than a cached copy.

## Failure modes
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the line items from the recovery point identified in the preconditions, reattach invoice to the billing system, and confirm the settlement flag returns to baseline. Never leave invoice in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond invoice, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-access`
- `audit-credential`
- `audit-account`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
The change owner is expected to verify the settlement flag independently rather than trusting a single reading. The on-call responder should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the billing system returns an ambiguous response. An auditor reconstructing the timeline later should confirm the tax summary reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response. The on-call responder should confirm the payment reference reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The operator running this procedure should keep the blast radius small and the operation reversible at every point.

The person who signs off the operation needs to confirm that the ledger actually accepted the change and now reflects it. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the line items reflects the intended state before treating the step as complete. The on-call responder should leave a clear note for the next person about what remains and why. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. The on-call responder should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The on-call responder needs to confirm that the billing system actually accepted the change and now reflects it. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the billing system returns an ambiguous response.

Anyone continuing this work in a follow-up session should confirm the balance reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should confirm the tax summary reflects the intended state before treating the step as complete. The operator running this procedure should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response.

The change owner should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner must record what was observed against the operation id so the history stays reconstructable. The change owner should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the billing system returns an ambiguous response.
