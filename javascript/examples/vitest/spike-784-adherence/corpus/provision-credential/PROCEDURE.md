---
id: provision-credential
kind: procedure
keywords: [provision, credential, controlled, runbook, recovery]
links: [escalate-ticket, validate-file, decommission-datastore, provision-account]
status: active
---
# Provision Credential

## Purpose
This procedure describes how to create and prepare credential for first use. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around credential:
- The secret material
- The rotation record
- The access scope
- The expiry timestamp

## Procedure
1. Allocate credential in the identity provider.
2. Apply the baseline configuration.
3. Attach the access scope.
4. Confirm the validation check.

## Verification
Confirm the validation check is within its expected bound and that the rotation record reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the secret store rather than a cached copy.

## Failure modes
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the rotation record from the recovery point identified in the preconditions, reattach credential to the audit ledger, and confirm the validation check returns to baseline. Never leave credential in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond credential, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-file`
- `decommission-datastore`
- `provision-account`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.

## Additional considerations
The change owner must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later is expected to verify the validation check independently rather than trusting a single reading. Anyone continuing this work in a follow-up session needs to confirm that the secret store actually accepted the change and now reflects it. The operator running this procedure must not disable a check to make progress, because a failing check is information.

The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session needs to confirm that the secret store actually accepted the change and now reflects it. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the secret store returns an ambiguous response. The person who signs off the operation is expected to verify the validation check independently rather than trusting a single reading. An auditor reconstructing the timeline later should confirm the secret material reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the validation check independently rather than trusting a single reading.

The operator running this procedure is expected to verify the validation check independently rather than trusting a single reading. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The on-call responder should leave a clear note for the next person about what remains and why. The person who signs off the operation should prefer stopping over guessing whenever the identity provider returns an ambiguous response.

An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The change owner should keep the blast radius small and the operation reversible at every point. The change owner needs to confirm that the audit ledger actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should confirm the access scope reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards needs to confirm that the secret store actually accepted the change and now reflects it. The change owner must not disable a check to make progress, because a failing check is information. The person who signs off the operation is expected to verify the validation check independently rather than trusting a single reading. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should confirm the expiry timestamp reflects the intended state before treating the step as complete.
