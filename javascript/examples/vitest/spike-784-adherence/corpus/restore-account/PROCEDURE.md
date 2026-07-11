---
id: restore-account
kind: procedure
keywords: [restore, account, controlled, runbook, recovery]
links: [escalate-ticket, decommission-account, reconcile-payment, audit-record]
status: active
---
# Restore Account

## Purpose
This procedure describes how to recover account from a known-good copy. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around account:
- The account record
- The entitlement set
- The contact profile
- The tier assignment

## Procedure
1. Select the recovery point for account.
2. Restore the contact profile into the billing system.
3. Verify the activation status.
4. Reconcile any gap.

## Verification
Confirm the activation status is within its expected bound and that the tier assignment reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the billing system rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the account record from the recovery point identified in the preconditions, reattach account to the billing system, and confirm the activation status returns to baseline. Never leave account in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond account, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `decommission-account`
- `reconcile-payment`
- `audit-record`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.

## Additional considerations
The change owner is expected to verify the activation status independently rather than trusting a single reading. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The on-call responder should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later is expected to verify the activation status independently rather than trusting a single reading. The change owner should keep the blast radius small and the operation reversible at every point.

A reviewer checking the result afterwards should confirm the tier assignment reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later is expected to verify the activation status independently rather than trusting a single reading. A reviewer checking the result afterwards is expected to verify the activation status independently rather than trusting a single reading. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should confirm the contact profile reflects the intended state before treating the step as complete. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the tier assignment reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder is expected to verify the activation status independently rather than trusting a single reading. An auditor reconstructing the timeline later should confirm the tier assignment reflects the intended state before treating the step as complete. The operator running this procedure should prefer stopping over guessing whenever the billing system returns an ambiguous response.

The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder needs to confirm that the directory actually accepted the change and now reflects it. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The person who signs off the operation needs to confirm that the directory actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session needs to confirm that the billing system actually accepted the change and now reflects it.

The operator running this procedure is expected to verify the activation status independently rather than trusting a single reading. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.
