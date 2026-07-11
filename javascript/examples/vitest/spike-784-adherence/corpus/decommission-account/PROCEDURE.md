---
id: decommission-account
kind: procedure
keywords: [decommission, account, safety, operation, procedure]
links: [escalate-ticket, reconfigure-service, drain-service, snapshot-cluster]
status: active
---
# Decommission Account

## Purpose
This procedure describes how to retire account and reclaim its resources cleanly. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around account:
- The account record
- The entitlement set
- The contact profile
- The tier assignment

## Procedure
1. Confirm account carries no live traffic.
2. Detach account from the provisioning queue.
3. Archive the tier assignment.
4. Record the retirement.

## Verification
Confirm the activation status is within its expected bound and that the tier assignment reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the billing system rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the contact profile from the recovery point identified in the preconditions, reattach account to the billing system, and confirm the activation status returns to baseline. Never leave account in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond account, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `reconfigure-service`
- `drain-service`
- `snapshot-cluster`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.

## Additional considerations
The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The on-call responder should prefer stopping over guessing whenever the provisioning queue returns an ambiguous response. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the activation status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session needs to confirm that the billing system actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards is expected to verify the activation status independently rather than trusting a single reading. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the provisioning queue returns an ambiguous response. The person who signs off the operation should prefer stopping over guessing whenever the provisioning queue returns an ambiguous response. The operator running this procedure must not disable a check to make progress, because a failing check is information.

The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should confirm the account record reflects the intended state before treating the step as complete. The change owner is expected to verify the activation status independently rather than trusting a single reading. The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure needs to confirm that the provisioning queue actually accepted the change and now reflects it. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point.

The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards is expected to verify the activation status independently rather than trusting a single reading. The operator running this procedure should confirm the tier assignment reflects the intended state before treating the step as complete. The change owner must not disable a check to make progress, because a failing check is information.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The change owner must not disable a check to make progress, because a failing check is information. The on-call responder must not disable a check to make progress, because a failing check is information. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.
