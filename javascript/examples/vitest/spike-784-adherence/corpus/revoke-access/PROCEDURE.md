---
id: revoke-access
kind: procedure
keywords: [revoke, access, safety, runbook, audited]
links: [escalate-ticket, audit-cluster, archive-file, decommission-cluster]
status: active
---
# Revoke Access Grant

## Purpose
This procedure describes how to invalidate access grant so it can no longer be used. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around access grant:
- The role binding
- The scope set
- The expiry
- The approval record

## Procedure
1. Locate every place access grant is honored.
2. Invalidate it in the directory.
3. Confirm the grant status shows it inactive.
4. Log the revocation in the approval record.

## Verification
Confirm the grant status is within its expected bound and that the scope set reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the audit ledger rather than a cached copy.

## Failure modes
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the scope set from the recovery point identified in the preconditions, reattach access grant to the identity provider, and confirm the grant status returns to baseline. Never leave access grant in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond access grant, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-cluster`
- `archive-file`
- `decommission-cluster`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.

## Additional considerations
The person who signs off the operation must not disable a check to make progress, because a failing check is information. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information. The on-call responder must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point.

The operator running this procedure should prefer stopping over guessing whenever the identity provider returns an ambiguous response. The operator running this procedure should confirm the approval record reflects the intended state before treating the step as complete. The on-call responder is expected to verify the grant status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the expiry reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the expiry reflects the intended state before treating the step as complete. The change owner needs to confirm that the directory actually accepted the change and now reflects it. The on-call responder needs to confirm that the directory actually accepted the change and now reflects it.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the audit ledger returns an ambiguous response. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should prefer stopping over guessing whenever the identity provider returns an ambiguous response.

The on-call responder must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session is expected to verify the grant status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The operator running this procedure should prefer stopping over guessing whenever the directory returns an ambiguous response. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

The operator running this procedure should confirm the role binding reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the directory returns an ambiguous response. An auditor reconstructing the timeline later should confirm the role binding reflects the intended state before treating the step as complete. The person who signs off the operation should leave a clear note for the next person about what remains and why. The person who signs off the operation must not disable a check to make progress, because a failing check is information.
