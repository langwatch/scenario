---
id: rotate-credential
kind: procedure
keywords: [rotate, credential, reversible, recovery, procedure]
links: [revoke-access, escalate-ticket, audit-account, dispatch-ticket]
status: active
---
# Rotate Credential

## Purpose
This procedure describes how to replace credential with a fresh instance and retire the old one. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around credential:
- The secret material
- The rotation record
- The access scope
- The expiry timestamp

## Procedure
1. Generate a replacement for credential.
2. Publish the new the secret material to the identity provider.
3. Confirm the validation check.
4. Schedule retirement of the old value.

## Verification
Confirm the validation check is within its expected bound and that the expiry timestamp reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the identity provider rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the secret material from the recovery point identified in the preconditions, reattach credential to the audit ledger, and confirm the validation check returns to baseline. Never leave credential in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond credential, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Follow-on procedures
After the steps above are complete, follow procedure `revoke-access` to carry out the required follow-on work. This is a transitive hand-off: the wider task is not finished until `revoke-access` has also been completed in full.

## Related procedures
- `revoke-access`
- `escalate-ticket`
- `audit-account`
- `dispatch-ticket`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.

## Additional considerations
Anyone continuing this work in a follow-up session is expected to verify the validation check independently rather than trusting a single reading. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

The on-call responder must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the secret store returns an ambiguous response. The operator running this procedure must not disable a check to make progress, because a failing check is information. The on-call responder should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

The person who signs off the operation should confirm the rotation record reflects the intended state before treating the step as complete. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the validation check independently rather than trusting a single reading. The operator running this procedure is expected to verify the validation check independently rather than trusting a single reading. An auditor reconstructing the timeline later is expected to verify the validation check independently rather than trusting a single reading.

A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The on-call responder should leave a clear note for the next person about what remains and why. The person who signs off the operation should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The on-call responder needs to confirm that the audit ledger actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should confirm the rotation record reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the audit ledger actually accepted the change and now reflects it. The on-call responder must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point.

The change owner should leave a clear note for the next person about what remains and why. The person who signs off the operation should confirm the rotation record reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should confirm the expiry timestamp reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable.
