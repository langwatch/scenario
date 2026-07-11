---
id: reconfigure-account
kind: procedure
keywords: [reconfigure, account, recovery, procedure, controlled]
links: [escalate-ticket, restore-dataset, revoke-certificate, archive-vendor]
status: active
---
# Reconfigure Account

## Purpose
This procedure describes how to change the configuration of account in a controlled way. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around account:
- The account record
- The entitlement set
- The contact profile
- The tier assignment

## Procedure
1. Capture the current configuration of account.
2. Apply the new settings to the billing system.
3. Validate against the activation status.
4. Persist the entitlement set.

## Verification
Confirm the activation status is within its expected bound and that the contact profile reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the directory rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the account record from the recovery point identified in the preconditions, reattach account to the billing system, and confirm the activation status returns to baseline. Never leave account in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond account, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `restore-dataset`
- `revoke-certificate`
- `archive-vendor`

## Notes and edge cases
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.

## Additional considerations
The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder should prefer stopping over guessing whenever the billing system returns an ambiguous response. A reviewer checking the result afterwards needs to confirm that the directory actually accepted the change and now reflects it. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation needs to confirm that the directory actually accepted the change and now reflects it.

An auditor reconstructing the timeline later is expected to verify the activation status independently rather than trusting a single reading. The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure needs to confirm that the directory actually accepted the change and now reflects it.

The on-call responder is expected to verify the activation status independently rather than trusting a single reading. A reviewer checking the result afterwards should confirm the tier assignment reflects the intended state before treating the step as complete. The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder should prefer stopping over guessing whenever the directory returns an ambiguous response. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The on-call responder must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should prefer stopping over guessing whenever the provisioning queue returns an ambiguous response. The on-call responder should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards is expected to verify the activation status independently rather than trusting a single reading. The on-call responder should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the billing system returns an ambiguous response. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the billing system returns an ambiguous response. A reviewer checking the result afterwards needs to confirm that the billing system actually accepted the change and now reflects it. An auditor reconstructing the timeline later is expected to verify the activation status independently rather than trusting a single reading. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards should prefer stopping over guessing whenever the provisioning queue returns an ambiguous response. The operator running this procedure should prefer stopping over guessing whenever the billing system returns an ambiguous response. The change owner should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The person who signs off the operation needs to confirm that the directory actually accepted the change and now reflects it.
