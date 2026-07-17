---
id: provision-account
kind: procedure
keywords: [provision, account, recovery, audited, operation]
links: [grant-access, escalate-ticket, audit-dataset, dispatch-invoice, reconcile-ticket]
status: active
---
# Provision Account

## Purpose
This procedure describes how to create and prepare account for first use. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around account:
- The account record
- The entitlement set
- The contact profile
- The tier assignment

## Procedure
1. Allocate account in the billing system.
2. Apply the baseline configuration.
3. Attach the entitlement set.
4. Confirm the activation status.

## Verification
Confirm the activation status is within its expected bound and that the tier assignment reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the billing system rather than a cached copy.

## Failure modes
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the tier assignment from the recovery point identified in the preconditions, reattach account to the billing system, and confirm the activation status returns to baseline. Never leave account in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond account, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Follow-on procedures
After the steps above are complete, follow procedure `grant-access` to carry out the required follow-on work. This is a transitive hand-off: the wider task is not finished until `grant-access` has also been completed in full.

## Related procedures
- `grant-access`
- `escalate-ticket`
- `audit-dataset`
- `dispatch-invoice`
- `reconcile-ticket`

## Notes and edge cases
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.

## Additional considerations
The change owner should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The change owner should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation needs to confirm that the provisioning queue actually accepted the change and now reflects it.

The on-call responder needs to confirm that the provisioning queue actually accepted the change and now reflects it. The operator running this procedure should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should confirm the contact profile reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The person who signs off the operation is expected to verify the activation status independently rather than trusting a single reading.

An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later needs to confirm that the provisioning queue actually accepted the change and now reflects it. The operator running this procedure needs to confirm that the directory actually accepted the change and now reflects it. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder should keep the blast radius small and the operation reversible at every point.

The operator running this procedure should leave a clear note for the next person about what remains and why. The change owner must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder should keep the blast radius small and the operation reversible at every point. The operator running this procedure needs to confirm that the billing system actually accepted the change and now reflects it.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the directory returns an ambiguous response. The person who signs off the operation needs to confirm that the provisioning queue actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session needs to confirm that the billing system actually accepted the change and now reflects it. The change owner is expected to verify the activation status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the entitlement set reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should confirm the tier assignment reflects the intended state before treating the step as complete. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.
