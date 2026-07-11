---
id: audit-credential
kind: procedure
keywords: [audit, credential, controlled, reversible, audited]
links: [escalate-ticket, drain-gateway, audit-vendor, restore-dataset]
status: active
---
# Audit Credential

## Purpose
This procedure describes how to review credential against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around credential:
- The secret material
- The rotation record
- The access scope
- The expiry timestamp

## Procedure
1. Enumerate credential in the identity provider.
2. Compare each against policy.
3. Record deviations in the expiry timestamp.
4. Confirm the validation check.

## Verification
Confirm the validation check is within its expected bound and that the expiry timestamp reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the audit ledger rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the rotation record from the recovery point identified in the preconditions, reattach credential to the secret store, and confirm the validation check returns to baseline. Never leave credential in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond credential, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `drain-gateway`
- `audit-vendor`
- `restore-dataset`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
The person who signs off the operation should prefer stopping over guessing whenever the secret store returns an ambiguous response. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the secret store returns an ambiguous response. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder should confirm the rotation record reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session is expected to verify the validation check independently rather than trusting a single reading. The on-call responder must not disable a check to make progress, because a failing check is information. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information. The person who signs off the operation should leave a clear note for the next person about what remains and why.

The on-call responder should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards is expected to verify the validation check independently rather than trusting a single reading. The on-call responder should confirm the secret material reflects the intended state before treating the step as complete. The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder needs to confirm that the secret store actually accepted the change and now reflects it.

An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should prefer stopping over guessing whenever the identity provider returns an ambiguous response. An auditor reconstructing the timeline later should confirm the secret material reflects the intended state before treating the step as complete. The operator running this procedure should confirm the expiry timestamp reflects the intended state before treating the step as complete. The operator running this procedure needs to confirm that the secret store actually accepted the change and now reflects it.

The change owner needs to confirm that the identity provider actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the secret store returns an ambiguous response. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the secret store returns an ambiguous response. The on-call responder should leave a clear note for the next person about what remains and why. The operator running this procedure needs to confirm that the identity provider actually accepted the change and now reflects it. The change owner is expected to verify the validation check independently rather than trusting a single reading.
