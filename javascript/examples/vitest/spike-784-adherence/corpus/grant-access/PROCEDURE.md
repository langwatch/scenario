---
id: grant-access
kind: procedure
keywords: [grant, access, operation, audited, safety]
links: [escalate-ticket, scale-service, audit-refund, purge-record]
status: active
---
# Grant Access Grant

## Purpose
This procedure describes how to give a principal the access grant it requires, no more. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around access grant:
- The role binding
- The scope set
- The expiry
- The approval record

## Procedure
1. Confirm the request scope for access grant.
2. Apply the binding in the audit ledger.
3. Set an expiry on the role binding.
4. Confirm the grant status.

## Verification
Confirm the grant status is within its expected bound and that the role binding reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the audit ledger rather than a cached copy.

## Failure modes
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the scope set from the recovery point identified in the preconditions, reattach access grant to the identity provider, and confirm the grant status returns to baseline. Never leave access grant in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond access grant, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `scale-service`
- `audit-refund`
- `purge-record`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The operator running this procedure needs to confirm that the directory actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the identity provider returns an ambiguous response. The change owner must not disable a check to make progress, because a failing check is information. The on-call responder should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The on-call responder must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later needs to confirm that the identity provider actually accepted the change and now reflects it. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session is expected to verify the grant status independently rather than trusting a single reading.

The on-call responder needs to confirm that the identity provider actually accepted the change and now reflects it. The change owner should leave a clear note for the next person about what remains and why. The on-call responder should confirm the approval record reflects the intended state before treating the step as complete. The person who signs off the operation should confirm the approval record reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point.

The person who signs off the operation should prefer stopping over guessing whenever the directory returns an ambiguous response. The on-call responder should confirm the scope set reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The on-call responder needs to confirm that the directory actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why.

The person who signs off the operation needs to confirm that the audit ledger actually accepted the change and now reflects it. The person who signs off the operation must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should prefer stopping over guessing whenever the identity provider returns an ambiguous response. The change owner should prefer stopping over guessing whenever the identity provider returns an ambiguous response.

Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should prefer stopping over guessing whenever the directory returns an ambiguous response. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The change owner should prefer stopping over guessing whenever the directory returns an ambiguous response. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point.
