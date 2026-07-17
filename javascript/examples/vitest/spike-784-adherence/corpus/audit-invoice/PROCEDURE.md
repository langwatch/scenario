---
id: audit-invoice
kind: procedure
keywords: [audit, invoice, reversible, safety, recovery]
links: [escalate-ticket, revoke-access, replicate-service, onboard-vendor]
status: active
---
# Audit Invoice

## Purpose
This procedure describes how to review invoice against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around invoice:
- The line items
- The tax summary
- The payment reference
- The balance

## Procedure
1. Enumerate invoice in the ledger.
2. Compare each against policy.
3. Record deviations in the balance.
4. Confirm the settlement flag.

## Verification
Confirm the settlement flag is within its expected bound and that the line items reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the reconciliation report rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the line items from the recovery point identified in the preconditions, reattach invoice to the ledger, and confirm the settlement flag returns to baseline. Never leave invoice in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond invoice, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `revoke-access`
- `replicate-service`
- `onboard-vendor`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The person who signs off the operation must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The on-call responder needs to confirm that the reconciliation report actually accepted the change and now reflects it.

The change owner should prefer stopping over guessing whenever the billing system returns an ambiguous response. The on-call responder should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session needs to confirm that the billing system actually accepted the change and now reflects it. The operator running this procedure must not disable a check to make progress, because a failing check is information.

The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner is expected to verify the settlement flag independently rather than trusting a single reading. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response. The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder is expected to verify the settlement flag independently rather than trusting a single reading.

The change owner should leave a clear note for the next person about what remains and why. The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable.

The change owner should confirm the balance reflects the intended state before treating the step as complete. The operator running this procedure must not disable a check to make progress, because a failing check is information. The operator running this procedure needs to confirm that the ledger actually accepted the change and now reflects it. The person who signs off the operation should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response. The person who signs off the operation should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later needs to confirm that the ledger actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should confirm the tax summary reflects the intended state before treating the step as complete. The person who signs off the operation should confirm the payment reference reflects the intended state before treating the step as complete. The operator running this procedure should prefer stopping over guessing whenever the reconciliation report returns an ambiguous response.
